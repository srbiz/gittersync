/**
 * GitterSync — Local Database Layer (Dexie.js / IndexedDB)
 *
 * Manages the local data store, changelog queue, and sync metadata.
 * All reads/writes happen here — offline-first.
 */

import Dexie, { type Table } from 'dexie';
import type { ChangelogEntry, SyncCursor, DeviceId, SyncedDocument } from './types';

// ─── Database Schema ──────────────────────────────────────────────────────

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
 * Only fixed tables are declared here. Collection tables are accessed
 * dynamically via `db.table(tableName)`.
 */
class GitterSyncDB extends Dexie {
    changelog_queue!: Table<LocalChangelogEntry, number>;
    sync_meta!: Table<SyncMeta, string>;

    constructor() {
        super('gittersync');

        // Base schema — only the fixed tables.
        // Collection tables use a separate Dexie instance (see below).
        this.version(1).stores({
            changelog_queue: '++localId, collection, docId, op, queuedAt, deviceId',
            sync_meta: 'key',
        });
    }
}

/**
 * A separate Dexie instance for collection data tables.
 *
 * Using a separate database allows us to dynamically add tables
 * without version conflicts with the metadata database.
 */
class CollectionsDB extends Dexie {
    constructor() {
        super('gittersync_collections');
        // Start with an empty schema — tables are added dynamically
        this.version(1).stores({});
    }
}

// ─── LocalDB Class ─────────────────────────────────────────────────────────

/**
 * Manages the local IndexedDB via Dexie.
 *
 * Responsibilities:
 * - Register and manage collection tables
 * - Queue local changes in the changelog
 * - Read/write documents with sync metadata
 * - Persist sync cursor and device ID
 */
export class LocalDB {
    private metaDb: GitterSyncDB;
    private collectionsDb: CollectionsDB;
    private registeredCollections = new Set<string>();
    private deviceId: DeviceId | null = null;

    constructor() {
        this.metaDb = new GitterSyncDB();
        this.collectionsDb = new CollectionsDB();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    /**
     * Initialize the local database.
     * Loads or generates the device ID.
     */
    async init(): Promise<DeviceId> {
        // Load or generate device ID
        const storedDeviceId = await this.getMeta('deviceId');
        if (storedDeviceId) {
            this.deviceId = storedDeviceId;
        } else {
            this.deviceId = crypto.randomUUID();
            await this.setMeta('deviceId', this.deviceId);
        }

        return this.deviceId;
    }

    /**
     * Get the device ID.
     */
    getDeviceId(): DeviceId {
        if (!this.deviceId) {
            throw new Error('LocalDB not initialized. Call init() first.');
        }
        return this.deviceId;
    }

    // ─── Collection Management ───────────────────────────────────────────

    /**
     * Register a collection — ensures the Dexie table exists.
     *
     * Must be called before reading/writing documents in the collection.
     */
    async registerCollection(name: string): Promise<void> {
        if (this.registeredCollections.has(name)) return;

        const tableName = this.getTableName(name);
        const tableExists = this.collectionsDb.tables.some((t) => t.name === tableName);

        if (!tableExists) {
            const schema: Record<string, string> = {};
            for (const existing of this.registeredCollections) {
                schema[this.getTableName(existing)] = 'id, updated_at, deleted_at';
            }
            schema[tableName] = 'id, updated_at, deleted_at';

            this.collectionsDb.version((this.collectionsDb.verno || 0) + 1).stores(schema);
        }

        this.registeredCollections.add(name);
    }

    /**
     * Get the Dexie table name for a collection.
     */
    private getTableName(collectionName: string): string {
        // Use a prefix to avoid conflicts with Dexie internal tables
        return `col_${collectionName}`;
    }

    // ─── Document CRUD ───────────────────────────────────────────────────

    /**
     * Get a document by ID from a collection.
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
     * Excludes soft-deleted documents by default.
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
     * Get all documents in a collection as a map keyed by ID.
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
     * Put a document into a collection (create or update).
     * Queues a changelog entry automatically.
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
     * Queues a changelog entry automatically.
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
     * Soft-delete a document.
     * Sets `deleted_at` and queues a delete changelog entry.
     */
    async deleteDocument(collection: string, docId: string): Promise<void> {
        const doc = await this.getDocument(collection, docId);
        if (!doc) return;

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
    }

    /**
     * Replace all documents in a collection.
     * Used during full pull — does NOT queue changelog entries.
     */
    async replaceCollection<T = Record<string, unknown>>(
        collection: string,
        documents: Record<string, SyncedDocument<T>>,
    ): Promise<void> {
        const table = this.getCollectionTable(collection);
        await table.clear();
        await table.bulkPut(Object.values(documents));
    }

    /**
     * Update documents in a collection by merging them with existing data.
     * Used during incremental pull — only updates documents that are newer.
     */
    async mergeDocuments<T = Record<string, unknown>>(
        collection: string,
        documents: Record<string, SyncedDocument<T>>,
        mergeFn: (local: SyncedDocument<T>, remote: SyncedDocument<T>) => SyncedDocument<T>,
    ): Promise<number> {
        let updatedCount = 0;
        const table = this.getCollectionTable(collection);

        for (const [id, remoteDoc] of Object.entries(documents)) {
            const localDoc = (await table.get(id)) as SyncedDocument<T> | undefined;

            if (!localDoc) {
                // New document — add it
                await table.put(remoteDoc);
                updatedCount++;
            } else {
                // Both exist — merge
                const merged = mergeFn(localDoc, remoteDoc);
                await table.put(merged);
                updatedCount++;
            }
        }

        return updatedCount;
    }

    // ─── Changelog Queue ─────────────────────────────────────────────────

    /**
     * Queue a changelog entry for later push to GitHub.
     */
    async queueChangelogEntry(entry: ChangelogEntry): Promise<void> {
        await this.metaDb.changelog_queue.add({
            ...entry,
            queuedAt: new Date().toISOString(),
            deviceId: this.getDeviceId(),
        });
    }

    /**
     * Get all pending changelog entries.
     */
    async getPendingChangelogEntries(): Promise<LocalChangelogEntry[]> {
        return this.metaDb.changelog_queue.orderBy('queuedAt').toArray();
    }

    /**
     * Get the count of pending changelog entries.
     */
    async getPendingChangelogCount(): Promise<number> {
        return this.metaDb.changelog_queue.count();
    }

    /**
     * Clear changelog entries that have been successfully pushed.
     */
    async clearChangelogEntries(localIds: number[]): Promise<void> {
        await this.metaDb.changelog_queue.bulkDelete(localIds);
    }

    /**
     * Clear all changelog entries.
     */
    async clearAllChangelogEntries(): Promise<void> {
        await this.metaDb.changelog_queue.clear();
    }

    // ─── Sync Metadata ──────────────────────────────────────────────────

    /**
     * Get the sync cursor.
     */
    async getSyncCursor(): Promise<SyncCursor | null> {
        const value = await this.getMeta('syncCursor');
        if (!value) return null;
        return JSON.parse(value) as SyncCursor;
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
     * Get the local schema version.
     */
    async getSchemaVersion(): Promise<number> {
        const value = await this.getMeta('schemaVersion');
        return value ? parseInt(value, 10) : 0;
    }

    /**
     * Set the local schema version.
     */
    async setSchemaVersion(version: number): Promise<void> {
        await this.setMeta('schemaVersion', version.toString());
    }

    // ─── Private Helpers ──────────────────────────────────────────────────

    private async getMeta(key: string): Promise<string | null> {
        const row = await this.metaDb.sync_meta.get(key);
        return row?.value ?? null;
    }

    private async setMeta(key: string, value: string): Promise<void> {
        await this.metaDb.sync_meta.put({ key, value });
    }

    private getCollectionTable(collection: string): Table<any, string> {
        const tableName = this.getTableName(collection);
        try {
            return this.collectionsDb.table(tableName);
        } catch {
            throw new Error(
                `Collection "${collection}" not registered. Call registerCollection() first.`,
            );
        }
    }

    private docToFieldChanges<T>(
        doc: SyncedDocument<T>,
    ): Record<string, { value: unknown; updatedAt: string }> {
        const changes: Record<string, { value: unknown; updatedAt: string }> = {};
        const data = doc.data as Record<string, unknown>;

        for (const [fieldName, fieldMeta] of Object.entries(doc._fields)) {
            changes[fieldName] = {
                value: data[fieldName],
                updatedAt: fieldMeta.updatedAt,
            };
        }

        return changes;
    }

    // ─── Public Utilities ────────────────────────────────────────────────

    /**
     * List all registered collection names.
     */
    getRegisteredCollections(): string[] {
        return [...this.registeredCollections];
    }

    /**
     * Export all local data for a full push to GitHub.
     */
    async exportAll(): Promise<Record<string, Record<string, SyncedDocument>>> {
        const result: Record<string, Record<string, SyncedDocument>> = {};

        for (const collection of this.registeredCollections) {
            result[collection] = await this.getAllDocumentsMap(collection, true);
        }

        return result;
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
