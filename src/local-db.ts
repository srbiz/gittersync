/**
 * GitterSync — Local Database Layer (Dexie.js / IndexedDB)
 *
 * Manages the local data store, the outbound changelog queue and sync metadata.
 * All reads and writes happen here first — the app is offline-first, and GitHub
 * is only ever touched by {@link GitHubSyncService}.
 *
 * ### Storage layout
 *
 * Two IndexedDB databases are used:
 *
 * | Database | Tables | Purpose |
 * |---|---|---|
 * | `gittersync` | `changelog_queue`, `sync_meta` | Fixed schema: outbound changes, cursor, device ID, schema version |
 * | `gittersync_collections` | `col_<name>` (one per collection) | Document cache, created on demand |
 *
 * Collection tables are created dynamically, so `registerCollection()` inspects
 * the *native* IndexedDB schema before declaring a new Dexie version. That keeps
 * three otherwise-broken scenarios working:
 *
 * 1. Registering a collection after the database was already opened (Dexie
 *    refuses `version()` on an open database).
 * 2. Re-opening the database in a later session, where the native version is
 *    higher than the freshly declared one (browsers reject that with a
 *    `VersionError`).
 * 3. Re-declaring a subset of the collections, which would otherwise make the
 *    remaining tables unreachable.
 */

import Dexie, { type Table } from 'dexie';
import type { ChangelogEntry, SyncCursor, DeviceId, SyncedDocument, FieldsMap } from './types';
import { ValidationError } from './types';
import { assertValidCollectionName } from './config';
import { createDocument as buildDocument } from './merge';

// ─── Database Schema ──────────────────────────────────────────────────────

/** Index specification used for every collection table. */
const COLLECTION_INDEX_SPEC = 'id, updated_at, deleted_at';

/** Prefix for collection tables — avoids collisions with the fixed tables. */
const TABLE_PREFIX = 'col_';

/** Name of the metadata database. */
export const META_DB_NAME = 'gittersync';

/** Name of the database holding collection tables. */
export const COLLECTIONS_DB_NAME = 'gittersync_collections';

/**
 * Local changelog entry — stored in the queue until pushed to GitHub.
 */
export interface LocalChangelogEntry extends ChangelogEntry {
    /** Auto-incremented local ID */
    localId?: number;
    /** ISO 8601 timestamp when this entry was created locally */
    queuedAt: string;
    /** Device that produced this change */
    deviceId: DeviceId;
}

/**
 * Sync metadata stored in Dexie.
 */
export interface SyncMeta {
    /** Meta key — e.g., 'syncCursor', 'deviceId', 'schemaVersion' */
    key: string;
    /** Meta value — stored as JSON string */
    value: string;
}

/**
 * GitterSync Dexie database.
 *
 * Only fixed tables are declared here. Collection tables live in a separate
 * database (see {@link CollectionsDB}).
 */
class GitterSyncDB extends Dexie {
    changelog_queue!: Table<LocalChangelogEntry, number>;
    sync_meta!: Table<SyncMeta, string>;

    constructor() {
        super(META_DB_NAME);

        this.version(1).stores({
            changelog_queue: '++localId, collection, docId, op, queuedAt, deviceId',
            sync_meta: 'key',
        });
    }
}

/**
 * A separate Dexie instance for collection data tables.
 *
 * Using a separate database allows tables to be added dynamically without
 * version conflicts with the metadata database.
 */
class CollectionsDB extends Dexie {
    constructor() {
        super(COLLECTIONS_DB_NAME);
        // Start with an empty schema — tables are added dynamically
        this.version(1).stores({});
    }
}

/** Native IndexedDB schema snapshot. */
interface NativeSchema {
    /** IDB version (Dexie stores `verno * 10`) */
    version: number;
    /** Object store names */
    stores: string[];
}

// ─── LocalDB Class ─────────────────────────────────────────────────────────

/**
 * Manages the local IndexedDB via Dexie.
 *
 * Responsibilities:
 * - Register and manage collection tables
 * - Queue local changes in the changelog
 * - Read/write documents with sync metadata
 * - Persist the sync cursor, device ID and schema version
 *
 * @example
 * ```typescript
 * const db = new LocalDB()
 * const deviceId = await db.init()
 * await db.registerCollection('users')
 *
 * const doc = await db.create('users', 'u1', { name: 'Alice' })
 * await db.updateFields('users', 'u1', { name: 'Alicia' })
 * await db.deleteDocument('users', 'u1')          // soft delete
 *
 * const active = await db.getAllDocuments<{ name: string }>('users')
 * const queued = await db.getPendingChangelogCount()   // 3 changes awaiting push
 * ```
 */
export class LocalDB {
    private metaDb: GitterSyncDB;
    private collectionsDb: CollectionsDB;
    private registeredCollections = new Set<string>();
    private deviceId: DeviceId | null = null;
    private initPromise: Promise<DeviceId> | null = null;

    constructor() {
        this.metaDb = new GitterSyncDB();
        this.collectionsDb = new CollectionsDB();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    /**
     * Initialize the local database: load or generate this device's ID.
     *
     * Safe to call repeatedly — concurrent calls share one initialisation.
     *
     * @returns The stable device ID (a UUID persisted in `sync_meta`)
     */
    async init(): Promise<DeviceId> {
        if (this.deviceId) return this.deviceId;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            const storedDeviceId = await this.getMeta('deviceId');
            if (storedDeviceId) {
                this.deviceId = storedDeviceId;
            } else {
                this.deviceId = randomId();
                await this.setMeta('deviceId', this.deviceId);
            }
            return this.deviceId;
        })();

        return this.initPromise;
    }

    /**
     * Get the device ID.
     *
     * @throws {Error} When {@link init} has not been called yet
     */
    getDeviceId(): DeviceId {
        if (!this.deviceId) {
            throw new Error('LocalDB not initialized. Call init() first.');
        }
        return this.deviceId;
    }

    // ─── Collection Management ───────────────────────────────────────────

    /**
     * Register a collection — ensures the backing IndexedDB table exists.
     *
     * Must be called before reading or writing documents in the collection.
     * Registering an already-registered collection is a no-op, and registering a
     * collection that a previous session created simply makes it visible again.
     *
     * As a side effect, every collection table found in the native database is
     * registered too, so data written by an earlier session never becomes
     * unreachable.
     *
     * @param name - Collection name (letters, digits, `.`, `_`, `-`; max 64 chars)
     * @throws {ValidationError} When the name is not usable as a file/table name
     */
    async registerCollection(name: string): Promise<void> {
        assertValidCollectionName(name);

        const tableName = this.getTableName(name);
        const alreadyDeclared = this.collectionsDb.tables.some((t) => t.name === tableName);
        if (alreadyDeclared) {
            // Table is part of the current declared schema — nothing to upgrade.
            this.registeredCollections.add(name);
            return;
        }

        // Look at what IndexedDB actually holds: the declared Dexie schema of a
        // fresh instance says nothing about tables created in an earlier session.
        const native = await this.inspectNativeSchema();
        const declaredVersion = this.collectionsDb.verno || 1;
        const nativeVersion = Math.ceil(native.version / 10); // Dexie stores verno * 10
        const nextVersion = Math.max(declaredVersion, nativeVersion) + 1;

        const schema: Record<string, string> = {};
        for (const store of native.stores) {
            if (store.startsWith(TABLE_PREFIX)) schema[store] = COLLECTION_INDEX_SPEC;
        }
        schema[tableName] = COLLECTION_INDEX_SPEC;

        // Dexie refuses schema changes on an open database.
        if (this.collectionsDb.isOpen()) {
            this.collectionsDb.close();
        }
        this.collectionsDb.version(nextVersion).stores(schema);

        for (const declared of Object.keys(schema)) {
            this.registeredCollections.add(declared.slice(TABLE_PREFIX.length));
        }

        await this.collectionsDb.open();
    }

    /** Whether a collection has been registered in this session. */
    isCollectionRegistered(name: string): boolean {
        return this.registeredCollections.has(name);
    }

    /**
     * List all registered collection names.
     *
     * Includes collections discovered in the native database, not only the ones
     * passed to {@link registerCollection} during this session.
     */
    getRegisteredCollections(): string[] {
        return [...this.registeredCollections];
    }

    /**
     * Get the Dexie table name for a collection.
     */
    private getTableName(collectionName: string): string {
        // Use a prefix to avoid conflicts with Dexie internal tables
        return `${TABLE_PREFIX}${collectionName}`;
    }

    /**
     * Read the native IndexedDB schema without involving Dexie.
     *
     * Opening without a version argument never triggers a version change, so it
     * cannot block or upgrade anything; the handle is closed immediately.
     */
    private async inspectNativeSchema(): Promise<NativeSchema> {
        if (typeof indexedDB === 'undefined') return { version: 0, stores: [] };

        try {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(COLLECTIONS_DB_NAME);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('IndexedDB open blocked'));
            });

            const stores = Array.from(db.objectStoreNames);
            const version = db.version;
            db.close();
            return { version, stores };
        } catch {
            // Environments without a usable IndexedDB fall back to the declared
            // schema only — Dexie will report the real error on first access.
            return { version: 0, stores: [] };
        }
    }

    // ─── Document CRUD ───────────────────────────────────────────────────

    /**
     * Get a document by ID from a collection.
     *
     * Soft-deleted documents are returned as well — check `deleted_at` (or use
     * {@link getAllDocuments}, which filters them by default).
     *
     * @param collection - Collection name
     * @param docId - Document ID
     * @returns The document, or `undefined` when it does not exist locally
     */
    async getDocument<T = Record<string, unknown>>(
        collection: string,
        docId: string,
    ): Promise<SyncedDocument<T> | undefined> {
        const table = this.getCollectionTable(collection);
        return table.get(docId) as Promise<SyncedDocument<T> | undefined>;
    }

    /**
     * Get all documents in a collection.
     *
     * @param collection - Collection name
     * @param includeDeleted - Set `true` to also return soft-deleted documents
     * @returns Documents ordered by `updated_at` (newest last)
     */
    async getAllDocuments<T = Record<string, unknown>>(
        collection: string,
        includeDeleted = false,
    ): Promise<SyncedDocument<T>[]> {
        const table = this.getCollectionTable(collection);
        const all = (await table.toArray()) as SyncedDocument<T>[];

        if (includeDeleted) return all;
        return all.filter((doc) => !doc.deleted_at);
    }

    /**
     * Get all documents in a collection as a map keyed by ID — the shape used by
     * collection files and merge helpers.
     *
     * @param collection - Collection name
     * @param includeDeleted - Set `true` to also return soft-deleted documents
     */
    async getAllDocumentsMap<T = Record<string, unknown>>(
        collection: string,
        includeDeleted = false,
    ): Promise<Record<string, SyncedDocument<T>>> {
        const docs = await this.getAllDocuments<T>(collection, includeDeleted);
        const map: Record<string, SyncedDocument<T>> = {};
        for (const doc of docs) {
            map[doc.id] = doc;
        }
        return map;
    }

    /**
     * Filter documents in memory — convenient for small collections where an
     * extra index is not worth the schema churn.
     *
     * @param collection - Collection name
     * @param predicate - Filter applied to each document's `data`
     * @param includeDeleted - Set `true` to also consider soft-deleted documents
     *
     * @example
     * ```typescript
     * const openTasks = await db.queryDocuments<Task>('tasks', t => !t.done)
     * ```
     */
    async queryDocuments<T = Record<string, unknown>>(
        collection: string,
        predicate: (data: T, doc: SyncedDocument<T>) => boolean,
        includeDeleted = false,
    ): Promise<SyncedDocument<T>[]> {
        const docs = await this.getAllDocuments<T>(collection, includeDeleted);
        return docs.filter((doc) => predicate(doc.data, doc));
    }

    /**
     * Count documents in a collection.
     *
     * @param collection - Collection name
     * @param includeDeleted - Set `true` to count soft-deleted documents too
     */
    async getDocumentCount(collection: string, includeDeleted = false): Promise<number> {
        if (includeDeleted) {
            return this.getCollectionTable(collection).count();
        }
        const docs = await this.getAllDocuments(collection, false);
        return docs.length;
    }

    /**
     * Create a document from plain app data.
     *
     * Builds the field-level metadata, stores the document and queues a `create`
     * changelog entry — the highest-level write helper in the local API.
     *
     * @param collection - Collection name
     * @param id - Document ID (must be unique within the collection)
     * @param data - Application data
     * @param timestamp - Override the `updatedAt` timestamp (default: now)
     * @returns The stored document
     * @throws {ValidationError} When a document with this ID already exists
     *
     * @example
     * ```typescript
     * await db.create('users', 'u1', { name: 'Alice', role: 'admin' })
     * ```
     */
    async create<T = Record<string, unknown>>(
        collection: string,
        id: string,
        data: T,
        timestamp?: string,
    ): Promise<SyncedDocument<T>> {
        if (typeof id !== 'string' || id.length === 0) {
            throw new ValidationError('id', 'Document id must be a non-empty string');
        }
        const existing = await this.getDocument<T>(collection, id);
        if (existing) {
            throw new ValidationError(
                `${collection}/${id}`,
                'Document already exists — use updateFields() or putDocument() instead',
            );
        }

        const doc = buildDocument<T>(id, data, this.getDeviceId(), timestamp);
        await this.createDocument(collection, doc);
        return doc;
    }

    /**
     * Patch specific fields of a document with correct field-level metadata.
     *
     * Only the touched fields get a new `updatedAt`, which is what makes
     * concurrent edits to *different* fields merge without conflicts.
     *
     * @param collection - Collection name
     * @param docId - Document ID
     * @param changes - Fields to set (a field set to `undefined` is removed)
     * @param timestamp - Override the change timestamp (default: now)
     * @returns The updated document, or `null` when it does not exist locally
     *
     * @example
     * ```typescript
     * // Drag & drop: only `columnId` and `position` change, so another device
     * // editing the title at the same time is not overwritten.
     * await db.updateFields<Task>('tasks', taskId, { columnId: 'done', position: 3 })
     * ```
     */
    async updateFields<T = Record<string, unknown>>(
        collection: string,
        docId: string,
        changes: Partial<T>,
        timestamp = new Date().toISOString(),
    ): Promise<SyncedDocument<T> | null> {
        const existing = await this.getDocument<T>(collection, docId);
        if (!existing) return null;

        const deviceId = this.getDeviceId();
        const data = { ...(existing.data as Record<string, unknown>) };
        const fields: FieldsMap = { ...existing._fields };

        for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
            if (value === undefined) {
                delete data[key];
                delete fields[key];
                continue;
            }
            data[key] = value;
            fields[key] = { updatedAt: timestamp, device: deviceId };
        }

        const updated: SyncedDocument<T> = {
            ...existing,
            data: data as T,
            _fields: fields,
            updated_at: maxTimestamp(fields, timestamp),
        };

        await this.putDocument(collection, updated);
        return updated;
    }

    /**
     * Put a document into a collection (create or update).
     *
     * Queues a changelog entry automatically unless `queueChangelog` is `false`
     * (the sync engine uses `false` when applying *remote* changes, which must
     * not be echoed back).
     *
     * @param collection - Collection name
     * @param doc - Full document including `_fields` metadata
     * @param queueChangelog - Whether to record an outbound change (default `true`)
     */
    async putDocument<T = Record<string, unknown>>(
        collection: string,
        doc: SyncedDocument<T>,
        queueChangelog = true,
    ): Promise<void> {
        const table = this.getCollectionTable(collection);
        await table.put(doc);

        if (queueChangelog) {
            await this.queueChangelogEntry({
                collection,
                docId: doc.id,
                op: 'update',
                fields: this.docToFieldChanges(doc),
            });
        }
    }

    /**
     * Create a new document in a collection.
     *
     * @param collection - Collection name
     * @param doc - Full document including `_fields` metadata
     * @param queueChangelog - Whether to record an outbound change (default `true`)
     */
    async createDocument<T = Record<string, unknown>>(
        collection: string,
        doc: SyncedDocument<T>,
        queueChangelog = true,
    ): Promise<void> {
        const table = this.getCollectionTable(collection);
        await table.add(doc);

        if (queueChangelog) {
            await this.queueChangelogEntry({
                collection,
                docId: doc.id,
                op: 'create',
                fields: this.docToFieldChanges(doc),
            });
        }
    }

    /**
     * Soft-delete a document: sets `deleted_at`/`deleted_by` and queues a
     * `delete` changelog entry.
     *
     * The document stays in the local store as a tombstone until compaction
     * purges it (see `deleteRetentionMs`), which is what stops a delete from
     * being resurrected by a device that has not synced yet. Deleting an
     * already-deleted document is a no-op.
     *
     * @param collection - Collection name
     * @param docId - Document ID
     * @returns `true` when a delete was recorded, `false` when nothing changed
     */
    async deleteDocument(collection: string, docId: string): Promise<boolean> {
        const doc = await this.getDocument(collection, docId);
        if (!doc || doc.deleted_at) return false;

        const now = new Date().toISOString();
        doc.deleted_at = now;
        doc.deleted_by = this.getDeviceId();

        const table = this.getCollectionTable(collection);
        await table.put(doc);

        await this.queueChangelogEntry({
            collection,
            docId,
            op: 'delete',
            deletedAt: now,
        });
        return true;
    }

    /**
     * Undo a local soft-delete (e.g. a "Restore" action in the UI).
     *
     * Queues an `update` so other devices clear their tombstone as well.
     *
     * @param collection - Collection name
     * @param docId - Document ID
     * @returns The restored document, or `null` when it does not exist
     */
    async restoreDocument<T = Record<string, unknown>>(
        collection: string,
        docId: string,
    ): Promise<SyncedDocument<T> | null> {
        const doc = await this.getDocument<T>(collection, docId);
        if (!doc || !doc.deleted_at) return doc ?? null;

        const now = new Date().toISOString();
        const restored: SyncedDocument<T> = {
            ...doc,
            deleted_at: null,
            deleted_by: null,
            updated_at: maxTimestamp(doc._fields, now),
        };

        await this.putDocument(collection, restored);
        return restored;
    }

    /**
     * Replace all documents in a collection in a single transaction.
     *
     * Used during a full pull — does NOT queue changelog entries.
     *
     * @param collection - Collection name
     * @param documents - Documents keyed by ID
     */
    async replaceCollection<T = Record<string, unknown>>(
        collection: string,
        documents: Record<string, SyncedDocument<T>>,
    ): Promise<void> {
        const table = this.getCollectionTable(collection);
        const rows = Object.values(documents);

        await this.inCollectionTransaction(collection, async () => {
            await table.clear();
            if (rows.length > 0) await table.bulkPut(rows);
        });
    }

    /**
     * Merge remote documents into a collection, in a single transaction.
     *
     * Documents unknown locally are inserted; documents present on both sides go
     * through `mergeFn` (field-level LWW in the sync engine). Does NOT queue
     * changelog entries — these are remote changes.
     *
     * @param collection - Collection name
     * @param documents - Remote documents keyed by ID
     * @param mergeFn - Merge strategy for documents that exist on both sides
     * @returns Number of documents written
     */
    async mergeDocuments<T = Record<string, unknown>>(
        collection: string,
        documents: Record<string, SyncedDocument<T>>,
        mergeFn: (local: SyncedDocument<T>, remote: SyncedDocument<T>) => SyncedDocument<T>,
    ): Promise<number> {
        const entries = Object.entries(documents);
        if (entries.length === 0) return 0;

        const table = this.getCollectionTable(collection);
        let updatedCount = 0;

        await this.inCollectionTransaction(collection, async () => {
            const rows: SyncedDocument<T>[] = [];

            for (const [id, remoteDoc] of entries) {
                const localDoc = (await table.get(id)) as SyncedDocument<T> | undefined;
                rows.push(localDoc ? mergeFn(localDoc, remoteDoc) : remoteDoc);
            }

            if (rows.length > 0) {
                await table.bulkPut(rows);
                updatedCount = rows.length;
            }
        });

        return updatedCount;
    }

    /**
     * Remove every document in a collection (local cache only — GitHub is not
     * touched, so the next pull restores the data).
     *
     * @param collection - Collection name
     */
    async clearCollection(collection: string): Promise<void> {
        const table = this.getCollectionTable(collection);
        await table.clear();
    }

    // ─── Changelog Queue ─────────────────────────────────────────────────

    /**
     * Queue a changelog entry for the next push to GitHub.
     *
     * @param entry - The change to queue; `queuedAt` and `deviceId` are added here
     */
    async queueChangelogEntry(entry: ChangelogEntry): Promise<void> {
        await this.metaDb.changelog_queue.add({
            ...entry,
            queuedAt: new Date().toISOString(),
            deviceId: this.getDeviceId(),
        });
    }

    /**
     * Get all pending changelog entries in FIFO order.
     *
     * Entries queued within the same millisecond keep their insertion order
     * (sorted by `localId`), so a create is never pushed after its own update.
     */
    async getPendingChangelogEntries(): Promise<LocalChangelogEntry[]> {
        const entries = await this.metaDb.changelog_queue.orderBy('queuedAt').toArray();
        return entries.sort((a, b) =>
            a.queuedAt === b.queuedAt ? (a.localId ?? 0) - (b.localId ?? 0) : 0,
        );
    }

    /**
     * Get the count of pending changelog entries.
     */
    async getPendingChangelogCount(): Promise<number> {
        return this.metaDb.changelog_queue.count();
    }

    /**
     * Clear changelog entries that have been successfully pushed.
     *
     * @param localIds - `localId` values returned by {@link getPendingChangelogEntries}
     */
    async clearChangelogEntries(localIds: number[]): Promise<void> {
        if (!localIds.length) return;
        await this.metaDb.changelog_queue.bulkDelete(localIds);
    }

    /**
     * Clear all changelog entries — drops changes that were never pushed.
     */
    async clearAllChangelogEntries(): Promise<void> {
        await this.metaDb.changelog_queue.clear();
    }

    // ─── Sync Metadata ──────────────────────────────────────────────────

    /**
     * Get the sync cursor (last GitHub commit this device has seen).
     *
     * @returns The cursor, or `null` when this device has never synced
     */
    async getSyncCursor(): Promise<SyncCursor | null> {
        const value = await this.getMeta('syncCursor');
        if (!value) return null;
        try {
            return JSON.parse(value) as SyncCursor;
        } catch {
            // Corrupt cursor — treat as "never synced" so a full pull repairs it
            await this.clearSyncCursor();
            return null;
        }
    }

    /**
     * Save the sync cursor.
     */
    async setSyncCursor(cursor: SyncCursor): Promise<void> {
        await this.setMeta('syncCursor', JSON.stringify(cursor));
    }

    /**
     * Clear the sync cursor so the next pull performs a full re-sync.
     * Used after importing data to ensure consistency.
     */
    async clearSyncCursor(): Promise<void> {
        await this.metaDb.sync_meta.delete('syncCursor');
    }

    /**
     * Get the local schema version (0 when never set).
     */
    async getSchemaVersion(): Promise<number> {
        const value = await this.getMeta('schemaVersion');
        return value ? parseInt(value, 10) || 0 : 0;
    }

    /**
     * Set the local schema version.
     */
    async setSchemaVersion(version: number): Promise<void> {
        await this.setMeta('schemaVersion', version.toString());
    }

    /**
     * Read an arbitrary sync-meta value — useful for app-level bookkeeping that
     * should survive reloads (e.g. `'lastOpenedBoard'`).
     */
    async getMetaValue(key: string): Promise<string | null> {
        return this.getMeta(key);
    }

    /** Write an arbitrary sync-meta value. */
    async setMetaValue(key: string, value: string): Promise<void> {
        await this.setMeta(key, value);
    }

    // ─── Private Helpers ──────────────────────────────────────────────────

    private async getMeta(key: string): Promise<string | null> {
        const row = await this.metaDb.sync_meta.get(key);
        return row?.value ?? null;
    }

    private async setMeta(key: string, value: string): Promise<void> {
        await this.metaDb.sync_meta.put({ key, value });
    }

    /**
     * Run a callback inside a read/write transaction scoped to one collection
     * table, so multi-step writes (clear + bulkPut, merge + bulkPut) are atomic.
     *
     * Falls back to running the callback directly when Dexie cannot open a
     * transaction (e.g. a table that is not part of the current schema), keeping
     * the failure mode identical to a plain write.
     */
    private async inCollectionTransaction(
        collection: string,
        fn: () => Promise<void>,
    ): Promise<void> {
        const tableName = this.getTableName(collection);
        const db = this.collectionsDb as unknown as {
            transaction: (
                mode: string,
                tables: string[],
                scope: () => Promise<void>,
            ) => Promise<void>;
        };

        try {
            await db.transaction('rw', [tableName], fn);
        } catch (error) {
            if (isTransactionUnsupported(error)) {
                await fn();
                return;
            }
            throw error;
        }
    }

    private getCollectionTable(collection: string): Table<any, string> {
        assertValidCollectionName(collection);
        const tableName = this.getTableName(collection);
        try {
            return this.collectionsDb.table(tableName);
        } catch {
            throw new Error(
                `Collection "${collection}" not registered. Call registerCollection() first.`,
            );
        }
    }

    /**
     * Build the field changes for a changelog entry.
     *
     * Every key present in `data` is included — even one without an entry in
     * `_fields` (which can happen when a document was assembled by hand). Those
     * fall back to the document-level timestamp instead of being silently
     * dropped from the push.
     */
    private docToFieldChanges<T>(
        doc: SyncedDocument<T>,
    ): Record<string, { value: unknown; updatedAt: string }> {
        const changes: Record<string, { value: unknown; updatedAt: string }> = {};
        const data = (doc.data ?? {}) as Record<string, unknown>;
        const fields = doc._fields ?? {};
        const fallback = doc.updated_at || new Date().toISOString();

        for (const fieldName of new Set([...Object.keys(fields), ...Object.keys(data)])) {
            changes[fieldName] = {
                value: data[fieldName],
                updatedAt: fields[fieldName]?.updatedAt ?? fallback,
            };
        }

        return changes;
    }

    // ─── Public Utilities ────────────────────────────────────────────────

    /**
     * Export all local data (including tombstones) for a full push or a debug dump.
     *
     * @returns Collections keyed by name, each holding documents keyed by ID
     */
    async exportAll(): Promise<Record<string, Record<string, SyncedDocument>>> {
        const result: Record<string, Record<string, SyncedDocument>> = {};

        for (const collection of this.registeredCollections) {
            result[collection] = await this.getAllDocumentsMap(collection, true);
        }

        return result;
    }

    /**
     * Erase every local trace of this repository: all collection documents, the
     * changelog queue and all sync metadata **except** the device ID.
     *
     * Remote data is untouched; the next pull is a full pull.
     */
    async clearAll(): Promise<void> {
        for (const collection of this.registeredCollections) {
            try {
                await this.clearCollection(collection);
            } catch {
                // A table that cannot be opened holds no readable data anyway
            }
        }
        await this.metaDb.changelog_queue.clear();
        await this.metaDb.sync_meta.clear();

        // Keep this device's identity stable across resets.
        if (this.deviceId) {
            await this.setMeta('deviceId', this.deviceId);
        }
    }

    /**
     * Close both underlying databases.
     *
     * Call this before deleting the databases (tests) or when tearing the
     * service down; afterwards the instance must not be used again.
     */
    async close(): Promise<void> {
        try {
            this.collectionsDb.close();
        } catch {
            // already closed
        }
        try {
            this.metaDb.close();
        } catch {
            // already closed
        }
    }

    /**
     * Get the underlying metadata Dexie instance — for advanced usage.
     */
    getMetaDatabase(): GitterSyncDB {
        return this.metaDb;
    }

    /**
     * Get the underlying collections Dexie instance — for advanced usage.
     */
    getCollectionsDatabase(): CollectionsDB {
        return this.collectionsDb;
    }
}

// ─── Module Helpers ────────────────────────────────────────────────────────

/** Newest field timestamp, or `fallback` when the document has no fields. */
function maxTimestamp(fields: FieldsMap, fallback: string): string {
    const times = Object.values(fields ?? {}).map((f) => new Date(f.updatedAt).getTime());
    if (times.length === 0) return fallback;
    const max = Math.max(...times, new Date(fallback).getTime());
    return new Date(max).toISOString();
}

/** Whether an error means Dexie could not scope a transaction to the table. */
function isTransactionUnsupported(error: unknown): boolean {
    const message = (error as Error)?.message ?? '';
    return (
        error instanceof TypeError ||
        /not part of transaction|Table .* not part of schema/i.test(message)
    );
}

/** `crypto.randomUUID()` with a fallback for environments without Web Crypto. */
function randomId(): string {
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (webCrypto?.randomUUID) return webCrypto.randomUUID();
    return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
