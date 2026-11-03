/**
 * GitterSync — GitHub Sync Service
 *
 * The main orchestrator that coordinates:
 * - Pull from GitHub (full, or incremental via the Compare Commits API)
 * - Push of local changes as changelog entries
 * - Compaction of changelogs into collection files
 * - File upload/download with files-first ordering
 * - Field-level LWW merge using the merge module
 *
 * All public operations are serialised through an internal lock, so a manual
 * `push()` can never interleave with an auto-sync cycle, and every operation
 * reports how many GitHub REST API calls it consumed.
 */

import JSZip from 'jszip';
import { GitHubApiAdapter, type ApiUsage as ApiUsageSnapshot } from './github-api';
import { LocalDB } from './local-db';
import { mergeDocument, applyChangelogToCollection, getExpiredDeletes } from './merge';
import type {
    GitHubSyncConfig,
    SyncStatus,
    SyncCursor,
    PullResult,
    SyncResult,
    PushResult,
    CompactionResult,
    RateLimitInfo,
    ChangelogEntry,
    ChangelogFile,
    CollectionFile,
    MetaFile,
    ExportManifest,
    SyncedDocument,
    UploadableContent,
    FileRef,
    FetchFileOptions,
} from './types';
import { ConflictError, RateLimitError, ValidationError } from './types';
import {
    resolveConfig,
    assertValidCollectionName,
    assertValidRepoPath,
    DEFAULT_AUTO_SYNC_INTERVAL_MS,
    type ResolvedGitHubSyncConfig,
} from './config';
import { LIBRARY_VERSION } from './version';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** MIME types inferred from a file extension during upload. */
const MIME_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Convert an uploadable payload to base64 plus an exact byte size.
 *
 * Accepts a base64 string (the historical signature), a `Blob`/`File`, an
 * `ArrayBuffer` or a `Uint8Array`, so browser code can pass a `File` straight
 * from an `<input type="file">`.
 */
async function toBase64Payload(
    input: UploadableContent,
): Promise<{ base64: string; size: number }> {
    if (typeof input === 'string') {
        // Already base64 — strip an accidental data-URL prefix.
        const base64 =
            input.startsWith('data:') && input.includes(',')
                ? input.slice(input.indexOf(',') + 1)
                : input;
        return { base64, size: base64ByteLength(base64) };
    }

    let bytes: Uint8Array;
    let size: number;

    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        bytes = new Uint8Array(await input.arrayBuffer());
        size = input.size;
    } else if (input instanceof Uint8Array) {
        bytes = input;
        size = input.byteLength;
    } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
        size = input.byteLength;
    } else {
        throw new ValidationError('content', 'Unsupported upload payload type');
    }

    const nodeBuffer = (
        globalThis as {
            Buffer?: { from(bytes: Uint8Array): { toString(encoding: string): string } };
        }
    ).Buffer;

    if (nodeBuffer) {
        return { base64: nodeBuffer.from(bytes).toString('base64'), size };
    }

    if (typeof btoa !== 'function') {
        throw new Error('Neither btoa nor Buffer is available to encode the upload');
    }

    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { base64: btoa(binary), size };
}

/** Decoded byte length of a base64 string, accounting for padding. */
function base64ByteLength(base64: string): number {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// ─── GitHubSyncService ─────────────────────────────────────────────────────

/**
 * Main sync service — coordinates between the local database (Dexie/IndexedDB)
 * and the remote GitHub repository.
 *
 * @example
 * ```typescript
 * const sync = new GitHubSyncService({ owner: 'myuser', repo: 'my-app-db' })
 * await sync.init('ghp_xxxx')
 * await sync.registerCollections(['users', 'documents'])
 *
 * const result = await sync.pull()
 * console.log(result.type, result.apiCalls)   // 'full' | 'incremental' | 'none'
 *
 * const db = sync.getLocalDb()
 * const doc = createDocument('u1', { name: 'Alice' }, db.getDeviceId())
 * await db.createDocument('users', doc)
 *
 * await sync.push()
 * ```
 */
export class GitHubSyncService {
    private api: GitHubApiAdapter;
    private localDb: LocalDB;
    private config: ResolvedGitHubSyncConfig;

    /** Serialises pull/push/sync/compact so operations never interleave */
    private lock: Promise<unknown> = Promise.resolve();
    /** Synchronous claim counter — lets `sync()` refuse re-entrant calls */
    private claimedOps = 0;
    private syncingDepth = 0;
    private isSyncingFlag = false;

    private syncTimer: ReturnType<typeof setInterval> | null = null;
    private token: string | null = null;
    private initialized = false;
    private online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    private boundOnlineHandler: (() => void) | null = null;
    private boundOfflineHandler: (() => void) | null = null;
    private autoSyncIntervalMs = DEFAULT_AUTO_SYNC_INTERVAL_MS;

    /** Cached status values so `getStatus()` stays synchronous and cheap */
    private cachedCursor: SyncCursor | null = null;
    private cachedPendingChanges = 0;
    private cachedDeviceId = '';
    private cachedRepoSizeKb: number | null = null;
    private lastSyncAt: string | null = null;
    /** Skip auto-sync until this moment after a rate-limit error */
    private rateLimitedUntil = 0;

    /**
     * @param config - Repository coordinates plus optional tuning. Unknown or
     * missing options fall back to the documented defaults; invalid values throw
     * a {@link ValidationError} immediately rather than failing mid-sync.
     */
    constructor(config: GitHubSyncConfig) {
        this.config = resolveConfig(config);
        this.api = new GitHubApiAdapter(config);
        this.localDb = new LocalDB();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    /**
     * Initialize the sync service with a GitHub token.
     *
     * Verifies repository access (1 REST call), opens the local IndexedDB and
     * loads or generates this device's ID.
     *
     * @param token - GitHub PAT (classic `repo` scope) or OAuth token
     * @returns `true` when both the remote and local sides are ready
     * @throws {AuthError} When the token is rejected
     * @throws {ValidationError} When the token is empty
     */
    async init(token: string): Promise<boolean> {
        this.token = token;

        // Initialize GitHub API adapter
        await this.api.init(token);

        // Initialize local database
        const deviceId = await this.localDb.init();
        this.cachedDeviceId = deviceId ?? this.safeDeviceId();

        this.initialized = true;
        await this.refreshCachedStatus();
        this.emitStatus();
        return true;
    }

    /**
     * Register the collections this app uses.
     *
     * Must be called after {@link init} and before any read/write operation on
     * those collections. Registering twice is a no-op.
     *
     * @param names - Collection names. Each becomes `collections/<name>.json` in
     * the repository and an IndexedDB table locally, so names are restricted to
     * letters, digits, dots, underscores and hyphens.
     * @throws {ValidationError} When a name is empty or contains unsafe characters
     */
    async registerCollections(names: string[]): Promise<void> {
        if (!Array.isArray(names)) {
            throw new ValidationError('names', 'registerCollections expects an array of names');
        }
        for (const name of names) {
            assertValidCollectionName(name);
            await this.localDb.registerCollection(name);
        }
        await this.refreshCachedStatus();
    }

    // ─── Pull ───────────────────────────────────────────────────────────

    /**
     * Pull changes from GitHub.
     *
     * - No sync cursor yet → full pull of every collection file and changelog.
     * - Cursor present → Compare Commits API decides what changed, and only those
     *   files are downloaded (through `raw.githubusercontent.com` when possible).
     * - Cursor no longer resolvable (force-push, history rewrite) → the cursor is
     *   discarded and a full pull runs, so remote changes are never skipped.
     *
     * @returns What was pulled plus the REST call count
     */
    async pull(): Promise<PullResult> {
        this.ensureInitialized();
        return this.withLock(() => this.pullInternal());
    }

    private async pullInternal(): Promise<PullResult> {
        this.beginOp();
        this.resetApiUsage();

        try {
            const cursor = await this.localDb.getSyncCursor();
            const result = cursor ? await this.incrementalPull(cursor) : await this.fullPull();

            this.lastSyncAt = new Date().toISOString();
            await this.refreshCachedStatus();
            return this.withUsage(result);
        } finally {
            this.endOp();
        }
    }

    /**
     * Full pull — download all collection files and changelogs.
     * Used on first sync or when the cursor is invalid.
     */
    private async fullPull(): Promise<PullResult> {
        // 1. Download meta.json
        const metaResult = await this.api.fetchJsonFile<MetaFile>('meta.json');
        const meta = (metaResult?.content as MetaFile | null) ?? null;

        // 2. Determine which collections exist. Data may live only in
        // changelog entries (nothing has been compacted yet), so the changelog
        // directory is consulted too — otherwise a fresh device would pull
        // nothing at all and never even establish a sync cursor.
        const changelogFiles = await this.api.listDirectory('changelog');

        let collectionNames = meta
            ? Object.keys(meta.collections)
            : await this.guessCollectionNames();

        // Changelogs are downloaded once and reused: a repo whose data only
        // exists in changelogs must not fetch the same file twice.
        const changelogs: ChangelogFile[] = [];
        const downloadChangelogs = async (): Promise<ChangelogFile[]> => {
            if (changelogs.length === 0 && changelogFiles.length > 0) {
                for (const filename of changelogFiles) {
                    const result = await this.api.fetchJsonFile<ChangelogFile>(
                        `changelog/${filename}`,
                    );
                    if (result) changelogs.push(result.content as ChangelogFile);
                }
            }
            return changelogs;
        };

        if (collectionNames.length === 0 && changelogFiles.length > 0) {
            const seen = new Set<string>();
            for (const changelog of await downloadChangelogs()) {
                for (const change of changelog.changes ?? []) {
                    if (change.collection) seen.add(change.collection);
                }
            }
            collectionNames = [...seen];
        }

        if (collectionNames.length === 0 && changelogFiles.length === 0) {
            // Empty repo — nothing to pull. Still install a cursor when the
            // branch has commits, so the next pull is incremental instead of
            // repeating these directory listings forever.
            await this.tryInstallCursor();
            await this.refreshCachedStatus();
            return { type: 'none' };
        }

        // 3. Ensure all collections are registered locally
        for (const name of collectionNames) {
            if (!this.localDb.getRegisteredCollections().includes(name)) {
                await this.localDb.registerCollection(name);
            }
        }

        // 4. Download each collection file
        const collections: Record<string, CollectionFile> = {};
        for (const name of collectionNames) {
            const result = await this.api.fetchJsonFile<CollectionFile>(`collections/${name}.json`);
            if (result) {
                collections[name] = result.content as CollectionFile;
            }
        }

        // 4.5. Run schema migrations if needed
        await this.runMigrations(meta, collections);

        // 5. Apply changelog entries that are newer than the collection files
        const pendingChangelogs = await downloadChangelogs();

        // 6. Merge into local database
        let documentsMerged = 0;
        for (const [name, collectionFile] of Object.entries(collections)) {
            documentsMerged += await this.mergeCollectionFileToLocal(name, collectionFile);
        }

        // Apply changelogs on top
        let changelogOps = 0;
        for (const changelog of pendingChangelogs) {
            changelogOps += await this.applyChangelogToLocal(changelog);
        }

        // 7. Update sync cursor
        await this.installCursor(await this.resolveHeadSha());

        return { type: 'full', collections, meta, documentsMerged, changelogOps };
    }

    /**
     * Incremental pull — only download files that changed since the cursor.
     */
    private async incrementalPull(cursor: SyncCursor): Promise<PullResult> {
        // 1. Compare commits to find changed files
        const comparison = await this.api.compareCommits(cursor.sha);

        if (comparison.status === 'identical') {
            // Nothing changed remotely — keep the cursor timestamp fresh.
            await this.installCursor(comparison.headSha || cursor.sha);
            return { type: 'none' };
        }

        if (comparison.status === 'diverged' || comparison.status === 'behind') {
            // The cursor is no longer an ancestor of the branch head (force-push,
            // history rewrite, rollback). Applying "no changed files" here would
            // silently skip remote data, so re-read everything instead.
            console.warn(
                `[GitterSync] Cursor ${cursor.sha.slice(0, 7)} is ${comparison.status} from the branch head — falling back to a full pull`,
            );
            await this.localDb.clearSyncCursor();
            this.cachedCursor = null;
            return this.fullPull();
        }

        // 1.5. Fetch meta.json for migration check
        const metaResult = await this.api.fetchJsonFile<MetaFile>('meta.json');
        const meta = (metaResult?.content as MetaFile | null) ?? null;

        // 2. Download only changed files
        const changedCollections: Record<string, CollectionFile> = {};
        const changelogs: ChangelogFile[] = [];

        for (const filePath of comparison.changedFiles) {
            if (filePath.startsWith('collections/') && filePath.endsWith('.json')) {
                const result = await this.api.fetchJsonFile<CollectionFile>(filePath);
                if (result) {
                    const name = filePath.replace('collections/', '').replace('.json', '');
                    changedCollections[name] = result.content as CollectionFile;

                    // Ensure the collection is registered
                    if (!this.localDb.getRegisteredCollections().includes(name)) {
                        await this.localDb.registerCollection(name);
                    }
                }
            } else if (filePath.startsWith('changelog/') && filePath.endsWith('.json')) {
                const result = await this.api.fetchJsonFile<ChangelogFile>(filePath);
                if (result) {
                    changelogs.push(result.content as ChangelogFile);
                }
            }
        }

        // 2.5. Run schema migrations if needed
        await this.runMigrations(meta, changedCollections);

        // 3. Merge into local database
        let documentsMerged = 0;
        for (const [name, collectionFile] of Object.entries(changedCollections)) {
            documentsMerged += await this.mergeCollectionFileToLocal(name, collectionFile);
        }

        let changelogOps = 0;
        for (const changelog of changelogs) {
            changelogOps += await this.applyChangelogToLocal(changelog);
        }

        // 4. Update sync cursor — the compare response already knows the head
        await this.installCursor(await this.resolveHeadSha(comparison.headSha));

        return {
            type: 'incremental',
            collections: changedCollections,
            changelogs,
            documentsMerged,
            changelogOps,
        };
    }

    /**
     * Run schema migrations on collection data when the remote schema
     * version is higher than the local one.
     *
     * Migrations are applied in order of their `from` version. Each
     * migration's transform function is called with every collection's
     * documents, giving it a chance to reshape the data.
     *
     * @param meta - Remote meta.json (null if repo is empty)
     * @param collections - Downloaded collection files (mutated in place)
     */
    private async runMigrations(
        meta: MetaFile | null,
        collections: Record<string, CollectionFile>,
    ): Promise<void> {
        if (!meta) return;

        const remoteVersion = meta.schemaVersion;
        const localVersion = await this.localDb.getSchemaVersion();

        if (remoteVersion <= localVersion) return;

        const migrations = this.config.migrations;

        if (migrations.length === 0) {
            // No migrations defined but remote has higher version —
            // just update local version to match
            await this.localDb.setSchemaVersion(remoteVersion);
            return;
        }

        // Sort migrations by 'from' version and run applicable ones
        const sorted = [...migrations].sort((a, b) => a.from - b.from);

        for (const step of sorted) {
            // Skip migrations that have already been applied or that go beyond remote
            if (step.from < localVersion || step.to > remoteVersion) continue;

            // Apply transform to each collection's documents
            for (const [name, collectionFile] of Object.entries(collections)) {
                const transformed = step.transform(name, collectionFile.documents, meta);
                collectionFile.documents = transformed;
            }
        }

        await this.localDb.setSchemaVersion(remoteVersion);
    }

    // ─── Push ───────────────────────────────────────────────────────────

    /**
     * Push local changelog entries to GitHub.
     *
     * Batches every pending entry into a single changelog file (1–2 REST calls),
     * drains the local queue, then runs compaction when the remote changelog
     * directory reached `compactionThreshold`.
     *
     * @returns How many entries were pushed and what it cost
     */
    async push(): Promise<PushResult> {
        this.ensureInitialized();
        return this.withLock(() => this.pushInternal());
    }

    private async pushInternal(): Promise<PushResult> {
        this.beginOp();
        this.resetApiUsage();

        try {
            // 1. Get pending changelog entries
            const entries = await this.localDb.getPendingChangelogEntries();

            if (entries.length === 0) {
                return {
                    pushed: 0,
                    changelogPath: null,
                    compacted: false,
                    apiCalls: 0,
                    rawReads: 0,
                };
            }

            // 2. Build the changelog file
            const deviceId = this.localDb.getDeviceId();
            const timestamp = new Date().toISOString();
            const changelogFile: ChangelogFile = {
                deviceId,
                timestamp,
                changes: entries.map(({ localId, queuedAt, deviceId: _, ...entry }) => entry),
            };

            // 3. Push to GitHub
            const fileName = `changelog/${timestamp.replace(/[:.]/g, '-')}_${deviceId}.json`;
            const cursorBefore = await this.localDb.getSyncCursor();
            await this.api.createOrUpdateFileWithRetry(
                fileName,
                JSON.stringify(changelogFile, null, 2),
                `Sync ${entries.length} changes from ${deviceId}`,
            );

            // 4. Clear pushed entries from local queue
            const localIds = entries.filter((e) => e.localId !== undefined).map((e) => e.localId!);
            await this.localDb.clearChangelogEntries(localIds);

            // 5. Advance the sync cursor using the commit we just created —
            //    no extra listCommits request, and only when it is safe.
            await this.advanceCursorAfterWrite(cursorBefore);

            // 6. Check if compaction is needed
            let compacted = false;
            const changelogFiles = await this.api.listDirectory('changelog');
            if (changelogFiles.length >= this.config.compactionThreshold) {
                await this.compactInternal();
                compacted = true;
            }

            this.lastSyncAt = new Date().toISOString();
            await this.refreshCachedStatus();

            return {
                pushed: entries.length,
                changelogPath: fileName,
                compacted,
                apiCalls: this.usage().apiCalls,
                rawReads: this.usage().rawReads,
            };
        } finally {
            this.endOp();
        }
    }

    // ─── Full Sync ──────────────────────────────────────────────────────

    /**
     * Perform a full sync: pull remote changes, then push local changes.
     *
     * A GitHub 409 (another device committed first) retries the whole cycle up
     * to `maxRetries` times — the retry loop is bounded, so a permanently
     * conflicting repository surfaces an error instead of spinning forever.
     *
     * @returns What was pulled plus how many local changelog entries were
     * pushed (`type: 'none'` and `pushed: 0` when the sync was skipped because
     * another operation is already running)
     */
    async sync(): Promise<SyncResult> {
        this.ensureInitialized();

        if (this.isSyncingFlag || this.claimedOps > 0) {
            console.warn('[GitterSync] Sync skipped — already in progress');
            return { type: 'none', pushed: 0 };
        }

        this.claimedOps += 1;
        try {
            return await this.withLock(async () => {
                let attempt = 0;
                for (;;) {
                    try {
                        const pullResult = await this.pullInternal();
                        const pushResult = await this.pushInternal();
                        return { ...pullResult, pushed: pushResult.pushed };
                    } catch (error) {
                        if (error instanceof ConflictError && attempt < this.config.maxRetries) {
                            attempt += 1;
                            console.warn(
                                `[GitterSync] Conflict during sync, retrying (${attempt}/${this.config.maxRetries})...`,
                            );
                            continue;
                        }
                        throw error;
                    }
                }
            });
        } finally {
            this.claimedOps -= 1;
        }
    }

    // ─── Compaction ─────────────────────────────────────────────────────

    /**
     * Compact changelog entries into collection files.
     *
     * Reads every remote changelog, applies the entries to the matching
     * collection file, purges soft-deletes older than `deleteRetentionMs`, then
     * removes the applied changelog files and refreshes `meta.json`.
     *
     * Collection files are read with `{ forceApi: true }`: a compaction
     * rewrites the whole file, so a CDN-cached copy could resurrect data that
     * another device just compacted.
     *
     * @returns What was compacted and what it cost
     */
    async compact(): Promise<CompactionResult> {
        this.ensureInitialized();
        return this.withLock(() => this.compactInternal());
    }

    private async compactInternal(): Promise<CompactionResult> {
        this.beginOp();
        this.resetApiUsage();

        const emptyResult: CompactionResult = {
            changelogsCompacted: 0,
            collectionsWritten: [],
            purgedDeletes: 0,
            apiCalls: 0,
        };

        try {
            // 1. Get all changelog files
            const changelogFiles = await this.api.listDirectory('changelog');
            if (changelogFiles.length === 0) return emptyResult;

            // 2. Download all changelog entries
            const changelogs: ChangelogFile[] = [];
            for (const filename of changelogFiles) {
                const result = await this.api.fetchJsonFile<ChangelogFile>(`changelog/${filename}`);
                if (result) {
                    changelogs.push(result.content as ChangelogFile);
                }
            }

            // 3. Group changes by collection
            const changesByCollection: Record<string, ChangelogEntry[]> = {};
            for (const cl of changelogs) {
                for (const change of cl.changes) {
                    if (!changesByCollection[change.collection]) {
                        changesByCollection[change.collection] = [];
                    }
                    changesByCollection[change.collection].push(change);
                }
            }

            // 4. For each affected collection, pull, apply changelogs, push
            const collectionsWritten: string[] = [];
            let purgedDeletes = 0;

            for (const [collectionName, changes] of Object.entries(changesByCollection)) {
                const result = await this.api.fetchJsonFile<CollectionFile>(
                    `collections/${collectionName}.json`,
                    { forceApi: true },
                );

                let collectionData: CollectionFile;
                if (result) {
                    collectionData = result.content as CollectionFile;
                } else {
                    // Collection file doesn't exist yet — create empty
                    collectionData = {
                        collection: collectionName,
                        version: 0,
                        updatedAt: new Date().toISOString(),
                        documents: {},
                    };
                }

                // Apply changelogs
                const deviceId = this.localDb.getDeviceId();
                const merged = applyChangelogToCollection(collectionData, changes, deviceId);

                // Purge expired soft-deletes
                const expiredIds = getExpiredDeletes(
                    merged.documents,
                    this.config.deleteRetentionMs,
                );
                for (const id of expiredIds) {
                    delete merged.documents[id];
                }
                purgedDeletes += expiredIds.length;

                // Push updated collection file
                await this.api.createOrUpdateFileWithRetry(
                    `collections/${collectionName}.json`,
                    JSON.stringify(merged, null, 2),
                    `Compact: merge ${changes.length} changes into ${collectionName}`,
                );
                collectionsWritten.push(collectionName);
            }

            // 5. Delete applied changelog files
            for (const filename of changelogFiles) {
                try {
                    await this.api.deleteFile(
                        `changelog/${filename}`,
                        `Compact: remove applied changelog ${filename}`,
                    );
                } catch (error) {
                    // Non-fatal — changelog may have already been deleted by another device
                    console.warn(`[GitterSync] Failed to delete changelog ${filename}:`, error);
                }
            }

            // 6. Update meta.json
            await this.pushMetaUpdate();

            // 7. Update sync cursor
            await this.advanceCursorAfterWrite(await this.localDb.getSyncCursor());

            this.lastSyncAt = new Date().toISOString();
            await this.refreshCachedStatus();

            return {
                changelogsCompacted: changelogFiles.length,
                collectionsWritten,
                purgedDeletes,
                apiCalls: this.usage().apiCalls,
            };
        } finally {
            this.endOp();
        }
    }

    // ─── File Storage ──────────────────────────────────────────────────

    /**
     * Upload a binary file to GitHub.
     *
     * Uses files-first ordering: the file is uploaded BEFORE any metadata
     * reference is created, so a failed metadata write can only leave a harmless
     * orphan instead of a dangling pointer.
     *
     * @param filePath - Path within the repo, e.g. `files/task-1/photo.png`
     * @param content - Base64 string, `Blob`/`File`, `ArrayBuffer` or `Uint8Array`
     * @param message - Commit message (defaults to `Upload <filename>`)
     * @param mimeType - MIME type override; inferred from the extension otherwise
     * @returns File reference metadata for storing inside a document
     * @throws {ValidationError} When the path is unsafe or the file exceeds
     * GitHub's 1 MiB Contents API limit
     *
     * @example
     * ```typescript
     * // Browser: pass the File directly
     * const ref = await sync.uploadFile(`files/${taskId}/${file.name}`, file)
     * ```
     */
    async uploadFile(
        filePath: string,
        content: UploadableContent,
        message?: string,
        mimeType?: string,
    ): Promise<FileRef> {
        this.ensureInitialized();
        assertValidRepoPath(filePath);

        const { base64, size } = await toBase64Payload(content);
        const commitMessage = message ?? `Upload ${filePath.split('/').pop()}`;

        const sha = await this.api.uploadBinaryFile(filePath, base64, commitMessage);

        return {
            path: filePath,
            sha,
            size,
            mimeType: mimeType ?? guessMimeType(filePath),
        };
    }

    /**
     * Download a binary file from GitHub.
     *
     * Served by `raw.githubusercontent.com` when possible, which keeps
     * attachment-heavy apps well inside the hourly rate limit.
     *
     * @param filePath - Path within the repo
     * @param options - `{ forceApi: true }` bypasses the raw channel
     */
    async downloadFile(filePath: string, options: FetchFileOptions = {}): Promise<Blob> {
        this.ensureInitialized();
        assertValidRepoPath(filePath);
        return this.api.downloadBinaryFile(filePath, options);
    }

    /**
     * Delete a file from the repository (e.g. an attachment whose document was
     * removed). Missing files are not an error.
     *
     * @param filePath - Path within the repo
     * @param message - Commit message
     */
    async deleteFile(filePath: string, message?: string): Promise<void> {
        this.ensureInitialized();
        assertValidRepoPath(filePath);
        await this.api.deleteFile(filePath, message ?? `Delete ${filePath}`);
    }

    /**
     * List files stored under a directory, recursively.
     *
     * @param dir - Directory inside the repo, e.g. `files`
     * @returns Paths relative to `dir`
     */
    async listFiles(dir = 'files'): Promise<string[]> {
        this.ensureInitialized();
        return this.api.listDirectoryRecursive(dir);
    }

    // ─── Data Export/Import ────────────────────────────────────────────

    /**
     * Export all data from GitHub as a ZIP file.
     *
     * Fetches meta.json, all collection files, changelogs and binary files and
     * packages them into a downloadable archive. Bulk reads go through the raw
     * channel by default, so exporting a large repository is cheap in rate-limit
     * terms.
     *
     * @returns A Blob containing the ZIP archive
     */
    async exportData(): Promise<Blob> {
        this.ensureInitialized();

        const zip = new JSZip();
        const folder = zip.folder('gittersync-export')!;

        // 1. Fetch meta.json
        const metaResult = await this.api.fetchJsonFile<MetaFile>('meta.json');
        if (metaResult) {
            folder.file('meta.json', JSON.stringify(metaResult.content, null, 2));
        }

        // 2. Determine collection names
        const meta = metaResult?.content as MetaFile | undefined;
        const collectionNames =
            meta?.collections && Object.keys(meta.collections).length > 0
                ? Object.keys(meta.collections)
                : await this.guessCollectionNames();

        // 3. Fetch each collection file
        let changelogCount = 0;
        for (const name of collectionNames) {
            const result = await this.api.fetchJsonFile<CollectionFile>(`collections/${name}.json`);
            if (result) {
                folder.file(`collections/${name}.json`, JSON.stringify(result.content, null, 2));
            }
        }

        // 4. Fetch changelog files
        const changelogFiles = await this.api.listDirectory('changelog');
        for (const fileName of changelogFiles) {
            const result = await this.api.fetchJsonFile<ChangelogFile>(`changelog/${fileName}`);
            if (result) {
                folder.file(`changelog/${fileName}`, JSON.stringify(result.content, null, 2));
                changelogCount++;
            }
        }

        // 5. Fetch binary files — recursive, because attachments may live in
        // subfolders (e.g. `files/<taskId>/<name>.png`).
        let fileCount = 0;
        const binaryFiles = await this.api.listDirectoryRecursive('files');
        for (const fileName of binaryFiles) {
            try {
                const blob = await this.api.downloadBinaryFile(`files/${fileName}`);
                folder.file(`files/${fileName}`, blob);
                fileCount++;
            } catch {
                // Skip files that fail to download (may have been deleted)
            }
        }

        // 6. Create manifest
        const manifest: ExportManifest = {
            exportedAt: new Date().toISOString(),
            sourceVersion: LIBRARY_VERSION,
            collections: collectionNames,
            changelogCount,
            fileCount,
        };
        folder.file('manifest.json', JSON.stringify(manifest, null, 2));

        // 7. Generate the ZIP from the root: JSZip strips the folder prefix when
        // generating from a folder object, which would drop the documented
        // `gittersync-export/` structure.
        return zip.generateAsync({ type: 'blob' });
    }

    /**
     * Import data from a ZIP file, replacing local data.
     *
     * Parses the ZIP, validates its structure, replaces local collection data,
     * clears the sync cursor (forcing a full re-sync on the next pull) and adopts
     * the schema version recorded in `meta.json`.
     *
     * The local changelog queue is preserved, so changes made on this device
     * that have not been pushed yet survive the import.
     *
     * @param file - The ZIP file to import (as File or Blob)
     * @throws {ValidationError} If the file is not a valid ZIP, has no
     * `manifest.json`, or contains no collection files
     */
    async importData(file: File | Blob): Promise<void> {
        this.ensureInitialized();

        // 1. Parse ZIP
        let zip: JSZip;
        try {
            const buffer = await file.arrayBuffer();
            zip = await JSZip.loadAsync(buffer);
        } catch {
            throw new ValidationError('file', 'Invalid or corrupted ZIP file');
        }

        // Support both flat and nested (gittersync-export/) structures
        let prefix = '';
        if (zip.file('gittersync-export/manifest.json')) {
            prefix = 'gittersync-export/';
        }

        // 2. Validate structure
        const manifestFile = zip.file(`${prefix}manifest.json`);
        if (!manifestFile) {
            throw new ValidationError('manifest.json', 'Export ZIP is missing manifest.json');
        }

        // Check for at least one collection file
        const collectionFiles = zip
            .file(new RegExp(`^${prefix}collections/.+\\.json$`))
            .filter((f) => !f.dir);
        if (collectionFiles.length === 0) {
            throw new ValidationError('collections', 'Export ZIP contains no collection files');
        }

        // 3. Read manifest
        const manifestText = await manifestFile.async('string');
        const manifest = JSON.parse(manifestText) as ExportManifest;

        // 4. Read and apply each collection
        for (const collectionFile of collectionFiles) {
            const fileName = collectionFile.name.replace(`${prefix}collections/`, '');
            const collectionName = fileName.replace('.json', '');

            // Ensure collection is registered
            if (!this.localDb.getRegisteredCollections().includes(collectionName)) {
                await this.localDb.registerCollection(collectionName);
            }

            const content = await collectionFile.async('string');
            const collectionData = JSON.parse(content) as CollectionFile;

            // Convert documents array to map format for replaceCollection
            const documents: Record<string, SyncedDocument> = {};
            if (collectionData.documents) {
                for (const [docId, doc] of Object.entries(
                    collectionData.documents as Record<string, SyncedDocument>,
                )) {
                    documents[docId] = doc;
                }
            }

            await this.localDb.replaceCollection(collectionName, documents);
        }

        // 5. Update schema version from meta.json if present
        const metaFile = zip.file(`${prefix}meta.json`);
        if (metaFile) {
            const metaText = await metaFile.async('string');
            const meta = JSON.parse(metaText) as MetaFile;
            if (typeof meta.schemaVersion === 'number') {
                await this.localDb.setSchemaVersion(meta.schemaVersion);
            }
        }

        // 6. Clear sync cursor to force full re-sync
        await this.localDb.clearSyncCursor();

        // 7. Emit status change
        this.cachedCursor = null;
        await this.refreshCachedStatus();
        this.emitStatus();

        if (manifest?.sourceVersion && manifest.sourceVersion !== LIBRARY_VERSION) {
            console.info(
                `[GitterSync] Imported an export created by gittersync ${manifest.sourceVersion} (running ${LIBRARY_VERSION})`,
            );
        }
    }

    // ─── Auto Sync ─────────────────────────────────────────────────────

    /**
     * Start automatic sync on an interval.
     *
     * Behaviour:
     * - Cycles are skipped while the browser reports being offline.
     * - An `online` event triggers an immediate sync.
     * - A rate-limit error pauses cycles until GitHub's reset time instead of
     *   hammering an exhausted budget.
     * - Errors are logged, never thrown into the timer.
     *
     * @param intervalMs - Sync interval in milliseconds (default: 5 minutes)
     */
    startAutoSync(intervalMs = DEFAULT_AUTO_SYNC_INTERVAL_MS): void {
        this.stopAutoSync();
        this.autoSyncIntervalMs = Math.max(1000, Math.floor(intervalMs));

        const doSync = async (): Promise<void> => {
            if (!this.online) {
                return; // Skip sync cycle when offline
            }
            if (Date.now() < this.rateLimitedUntil) {
                return; // Rate limited — wait for the window to reset
            }
            try {
                await this.sync();
            } catch (error) {
                if (error instanceof RateLimitError) {
                    this.rateLimitedUntil = error.resetAt.getTime();
                    console.warn(
                        `[GitterSync] Auto-sync paused until ${error.resetAt.toISOString()} (rate limit)`,
                    );
                    this.emitStatus();
                    return;
                }
                console.error('[GitterSync] Auto-sync failed:', error);
            }
        };

        // Register online/offline event listeners
        if (typeof window !== 'undefined') {
            this.boundOnlineHandler = () => {
                this.online = true;
                this.rateLimitedUntil = 0;
                this.emitStatus();
                // Trigger an immediate sync when connectivity returns
                void doSync();
            };
            this.boundOfflineHandler = () => {
                this.online = false;
                this.emitStatus();
            };
            window.addEventListener('online', this.boundOnlineHandler);
            window.addEventListener('offline', this.boundOfflineHandler);
        }

        // Initial sync (if online)
        void doSync();

        // Set up interval
        this.syncTimer = setInterval(() => void doSync(), this.autoSyncIntervalMs);
    }

    /**
     * Stop automatic sync and remove the online/offline listeners.
     */
    stopAutoSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        // Remove online/offline event listeners
        if (typeof window !== 'undefined') {
            if (this.boundOnlineHandler) {
                window.removeEventListener('online', this.boundOnlineHandler);
                this.boundOnlineHandler = null;
            }
            if (this.boundOfflineHandler) {
                window.removeEventListener('offline', this.boundOfflineHandler);
                this.boundOfflineHandler = null;
            }
        }
    }

    /** Whether auto-sync is currently running. */
    get autoSyncRunning(): boolean {
        return this.syncTimer !== null;
    }

    /** The configured auto-sync interval in ms. */
    get autoSyncInterval(): number {
        return this.autoSyncIntervalMs;
    }

    /**
     * Whether the browser reports an active network connection.
     * Defaults to `true` in non-browser environments.
     */
    get isOnline(): boolean {
        return this.online;
    }

    // ─── Teardown ──────────────────────────────────────────────────────

    /**
     * Stop auto-sync, drop the token and close the local databases.
     *
     * Local data is kept — use {@link reset} to wipe it as well.
     */
    async destroy(): Promise<void> {
        this.stopAutoSync();
        this.token = null;
        this.initialized = false;
        await this.localDb.close();
        this.emitStatus();
    }

    /**
     * Erase every local trace of this repository: documents, changelog queue,
     * sync cursor and schema version. The next `pull()` is a full pull.
     *
     * Remote data is untouched.
     */
    async reset(): Promise<void> {
        await this.localDb.clearAll();
        this.cachedCursor = null;
        this.cachedPendingChanges = 0;
        this.lastSyncAt = null;
        this.emitStatus();
    }

    // ─── Status ─────────────────────────────────────────────────────────

    /**
     * Get the current sync status.
     *
     * Synchronous and free: values are cached by the running operations, so this
     * is safe to call from a render loop or the `onSyncStatusChange` callback.
     * Use {@link getFullStatus} to refresh repo size from GitHub.
     */
    getStatus(): SyncStatus {
        return {
            isSyncing: this.isSyncingFlag,
            isOnline: this.online,
            isInitialized: this.initialized,
            lastSyncAt: this.lastSyncAt,
            cursor: this.cachedCursor,
            deviceId: this.cachedDeviceId,
            pendingChanges: this.cachedPendingChanges,
            repoSizeKb: this.cachedRepoSizeKb,
            rateLimitRemaining: this.api.rateLimitRemaining ?? null,
            rateLimitResetAt: this.api.rateLimitResetAt?.toISOString() ?? null,
            rawContentActive: this.api.rawContentActive ?? false,
        };
    }

    /**
     * Get the full sync status, refreshing values that need I/O.
     *
     * Reads the cursor and pending-change count from IndexedDB and the repository
     * size from GitHub (1 REST call). Results are cached so the next
     * {@link getStatus} reports them too.
     */
    async getFullStatus(): Promise<SyncStatus> {
        await this.refreshCachedStatus();

        try {
            this.cachedRepoSizeKb = await this.api.getRepoSize();
        } catch {
            // Non-critical — keep the last known value
            this.cachedRepoSizeKb = this.api.getCachedRepoSize?.() ?? this.cachedRepoSizeKb;
        }

        return this.getStatus();
    }

    /**
     * Rate limit and transport counters — how much of the hourly budget this
     * service instance has spent, and how many reads the raw channel absorbed.
     */
    getRateLimitInfo(): RateLimitInfo {
        const usage = this.usage();
        return {
            remaining: this.api.rateLimitRemaining ?? null,
            resetAt: this.api.rateLimitResetAt?.toISOString() ?? null,
            apiCalls: usage.apiCalls,
            rawReads: usage.rawReads,
            rawMisses: usage.rawMisses,
            rawFallbacks: usage.rawFallbacks,
            rawContentActive: this.api.rawContentActive ?? false,
        };
    }

    /** Number of local changes waiting to be pushed (reads IndexedDB). */
    async getPendingChanges(): Promise<number> {
        const count = await this.localDb.getPendingChangelogCount();
        this.cachedPendingChanges = count;
        return count;
    }

    /** The resolved configuration this service is running with. */
    getConfig(): Readonly<ResolvedGitHubSyncConfig> {
        return this.config;
    }

    // ─── Local Database Access ──────────────────────────────────────────

    /**
     * Get the local database instance for direct document access.
     *
     * This is the offline-first API your UI reads and writes against; changes
     * are queued locally and reach GitHub on the next `push()`/`sync()`.
     *
     * @example
     * ```typescript
     * const db = sync.getLocalDb()
     * const users = await db.getAllDocuments<{ name: string }>('users')
     * await db.deleteDocument('users', users[0].id)
     * ```
     */
    getLocalDb(): LocalDB {
        return this.localDb;
    }

    /** The underlying GitHub API adapter — for advanced usage and diagnostics. */
    getApi(): GitHubApiAdapter {
        return this.api;
    }

    // ─── Private Helpers ────────────────────────────────────────────────

    /** Run an operation under the serialisation lock. */
    private withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn, fn);
        // Keep the chain alive even when an operation rejects.
        this.lock = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private beginOp(): void {
        this.syncingDepth += 1;
        if (!this.isSyncingFlag) {
            this.isSyncingFlag = true;
            this.emitStatus();
        }
    }

    private endOp(): void {
        this.syncingDepth = Math.max(0, this.syncingDepth - 1);
        if (this.syncingDepth === 0 && this.isSyncingFlag) {
            this.isSyncingFlag = false;
            this.emitStatus();
        }
    }

    /** Refresh the cached status fields that require IndexedDB reads. */
    private async refreshCachedStatus(): Promise<void> {
        try {
            this.cachedCursor = await this.localDb.getSyncCursor();
            this.cachedPendingChanges = await this.localDb.getPendingChangelogCount();
            this.cachedDeviceId = this.safeDeviceId() || this.cachedDeviceId;
            this.cachedRepoSizeKb = this.api.getCachedRepoSize?.() ?? this.cachedRepoSizeKb;
        } catch {
            // Status is best-effort — never fail an operation because of it
        }
    }

    private safeDeviceId(): string {
        try {
            return this.localDb.getDeviceId();
        } catch {
            return this.cachedDeviceId;
        }
    }

    /** Attach transport counters to a pull result. */
    private withUsage(result: PullResult): PullResult {
        if (result.type === 'none') return result;
        const usage = this.usage();
        return { ...result, apiCalls: usage.apiCalls, rawReads: usage.rawReads };
    }

    /**
     * Transport counters from the adapter.
     *
     * Optional-chained because applications may inject a custom or stubbed
     * adapter that predates the telemetry methods.
     */
    private usage(): ApiUsageSnapshot {
        return this.api.getUsage?.() ?? { apiCalls: 0, rawReads: 0, rawMisses: 0, rawFallbacks: 0 };
    }

    private resetApiUsage(): void {
        this.api.resetUsage?.();
    }

    /** Persist a new sync cursor (and the cached copy). */
    private async installCursor(sha: string): Promise<void> {
        if (!sha) return;
        const cursor: SyncCursor = { sha, timestamp: new Date().toISOString() };
        await this.localDb.setSyncCursor(cursor);
        this.cachedCursor = cursor;
    }

    /**
     * Install a cursor after a full pull of an *empty* repository, so repeated
     * pulls stop re-listing directories. A branch with no commits yet simply
     * keeps no cursor.
     */
    private async tryInstallCursor(): Promise<void> {
        try {
            await this.installCursor(await this.api.getLatestCommitSha());
        } catch {
            // Empty branch (no commits) — nothing to point a cursor at
        }
    }

    /**
     * Resolve the branch head, preferring a SHA we already paid for.
     *
     * @param knownHead - Head SHA from a compare response or a write
     */
    private async resolveHeadSha(knownHead?: string | null): Promise<string> {
        if (knownHead) return knownHead;
        return this.api.getLatestCommitSha();
    }

    /**
     * Advance the sync cursor after a write, without spending a request on
     * `listCommits` — and only when doing so cannot skip another device's work.
     *
     * - No cursor yet → install none. A device that has never pulled must keep
     *   doing full pulls, or it would silently skip the repository's history.
     * - Our commit's parent is the current cursor → nobody else committed in
     *   between, so the cursor moves to our commit for free.
     * - Otherwise → leave the cursor alone. The next pull re-reads the commits we
     *   skipped (including our own changelog, which merges idempotently).
     */
    private async advanceCursorAfterWrite(previous: SyncCursor | null): Promise<void> {
        if (!previous) return;

        const commit = this.api.getLastCommit?.() ?? null;

        if (commit?.sha && commit.parentShas.length > 0) {
            if (commit.parentShas.includes(previous.sha)) {
                await this.installCursor(commit.sha);
            }
            return;
        }

        if (commit?.sha) {
            // Parents were not reported — still safe, because a commit created by
            // this write is the branch head unless someone else raced us, and a
            // subsequent pull would detect that.
            await this.installCursor(commit.sha);
            return;
        }

        // Adapter reported nothing (e.g. a test double) — fall back to a lookup.
        try {
            await this.installCursor(await this.api.getLatestCommitSha());
        } catch {
            // Keep the previous cursor rather than losing it
        }
    }

    /**
     * Merge a remote collection file into the local database.
     * Uses field-level LWW merge for documents that exist on both sides.
     */
    private async mergeCollectionFileToLocal(
        collectionName: string,
        collectionFile: CollectionFile,
    ): Promise<number> {
        const remoteDocs = collectionFile.documents as Record<string, SyncedDocument>;

        await this.localDb.mergeDocuments(collectionName, remoteDocs, (localDoc, remoteDoc) =>
            mergeDocument(localDoc, remoteDoc),
        );
        return Object.keys(remoteDocs).length;
    }

    /**
     * Apply a remote changelog file to the local database.
     */
    private async applyChangelogToLocal(changelog: ChangelogFile): Promise<number> {
        // Group changes by collection
        const changesByCollection: Record<string, ChangelogEntry[]> = {};
        for (const change of changelog.changes) {
            if (!changesByCollection[change.collection]) {
                changesByCollection[change.collection] = [];
            }
            changesByCollection[change.collection].push(change);
        }

        // Apply each group to the corresponding local collection
        for (const [collectionName, changes] of Object.entries(changesByCollection)) {
            // Ensure collection is registered
            if (!this.localDb.getRegisteredCollections().includes(collectionName)) {
                await this.localDb.registerCollection(collectionName);
            }

            const deviceId = changelog.deviceId;

            for (const change of changes) {
                if (change.op === 'create') {
                    const doc = documentFromChange(change, deviceId);

                    // Check if document already exists locally
                    const existing = await this.localDb.getDocument(collectionName, change.docId);
                    if (existing) {
                        // Merge instead of overwrite
                        await this.localDb.putDocument(
                            collectionName,
                            mergeDocument(existing, doc),
                            false,
                        );
                    } else {
                        await this.localDb.putDocument(collectionName, doc, false);
                    }
                } else if (change.op === 'update') {
                    const existing = await this.localDb.getDocument(collectionName, change.docId);

                    if (!existing) {
                        // Upsert: an update for an unknown document still carries
                        // data (the create may not have reached this device yet).
                        await this.localDb.putDocument(
                            collectionName,
                            documentFromChange(change, deviceId),
                            false,
                        );
                        continue;
                    }

                    const updatedData = { ...(existing.data as Record<string, unknown>) };
                    const updatedFields = { ...existing._fields };

                    for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
                        const localFieldMeta = updatedFields[fieldName];
                        if (
                            !localFieldMeta ||
                            new Date(fieldData.updatedAt) > new Date(localFieldMeta.updatedAt)
                        ) {
                            updatedData[fieldName] = fieldData.value;
                            updatedFields[fieldName] = {
                                updatedAt: fieldData.updatedAt,
                                device: deviceId,
                            };
                        }
                    }

                    const allTimestamps = Object.values(updatedFields).map((f) =>
                        new Date(f.updatedAt).getTime(),
                    );
                    const maxTimestamp = Math.max(...allTimestamps);

                    const mergedDoc: SyncedDocument = {
                        ...existing,
                        data: updatedData,
                        _fields: updatedFields,
                        updated_at: new Date(maxTimestamp).toISOString(),
                    };

                    await this.localDb.putDocument(collectionName, mergedDoc, false);
                } else if (change.op === 'delete') {
                    const existing = await this.localDb.getDocument(collectionName, change.docId);

                    if (!existing) {
                        // Unknown document (created and deleted before this device
                        // saw it) — record a tombstone so the delete is not lost.
                        const deletedAt = change.deletedAt || new Date().toISOString();
                        await this.localDb.putDocument(
                            collectionName,
                            {
                                id: change.docId,
                                data: {},
                                _fields: {},
                                updated_at: deletedAt,
                                created_at: deletedAt,
                                deleted_at: deletedAt,
                                deleted_by: deviceId,
                            },
                            false,
                        );
                        continue;
                    }

                    // Only apply delete if it's newer than the last edit
                    if (
                        change.deletedAt &&
                        new Date(change.deletedAt) > new Date(existing.updated_at)
                    ) {
                        const deletedDoc: SyncedDocument = {
                            ...existing,
                            deleted_at: change.deletedAt,
                            deleted_by: deviceId,
                        };
                        await this.localDb.putDocument(collectionName, deletedDoc, false);
                    }
                }
            }
        }

        return changelog.changes?.length ?? 0;
    }

    /**
     * Push an updated meta.json to GitHub.
     *
     * Reads go through the REST API on purpose: `meta.json` records blob SHAs,
     * which raw responses cannot provide.
     */
    private async pushMetaUpdate(): Promise<void> {
        const collectionNames = this.localDb.getRegisteredCollections();
        const collections: Record<string, { version: number; sha: string }> = {};

        for (const name of collectionNames) {
            const result = await this.api.fetchJsonFile(`collections/${name}.json`, {
                forceApi: true,
            });
            collections[name] = {
                version: (result?.content as CollectionFile | undefined)?.version ?? 0,
                sha: result?.sha ?? '',
            };
        }

        // Count what is actually left rather than assuming zero: another device
        // can push a changelog while this compaction runs, and recording 0 would
        // hide that file from the next compaction check.
        let changelogCount: number;
        try {
            changelogCount = (await this.api.listDirectory('changelog')).length;
        } catch {
            // Directory listing failed — fall back to the previously recorded
            // count (a raw read) instead of silently resetting it.
            const existing = await this.api.fetchJsonFile<MetaFile>('meta.json');
            changelogCount = (existing?.content as MetaFile | undefined)?.changelogCount ?? 0;
        }

        const meta: MetaFile = {
            schemaVersion: await this.localDb.getSchemaVersion(),
            collections,
            changelogCount,
        };

        await this.api.createOrUpdateFileWithRetry(
            'meta.json',
            JSON.stringify(meta, null, 2),
            'Compact: update meta.json',
        );
    }

    /**
     * Try to guess collection names by listing the collections/ directory.
     */
    private async guessCollectionNames(): Promise<string[]> {
        const files = await this.api.listDirectory('collections');
        return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    }

    private ensureInitialized(): void {
        if (!this.token) {
            throw new Error('GitHubSyncService not initialized. Call init() first.');
        }
    }

    private emitStatus(): void {
        try {
            this.config.onSyncStatusChange(this.getStatus());
        } catch {
            // Callback errors should not break sync
        }
    }
}

// ─── Module Helpers ────────────────────────────────────────────────────────

/** Rebuild a document from a changelog entry (create or upserted update). */
function documentFromChange(change: ChangelogEntry, deviceId: string): SyncedDocument {
    const data: Record<string, unknown> = {};
    const fields: Record<string, { updatedAt: string; device: string }> = {};

    for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
        data[fieldName] = fieldData.value;
        fields[fieldName] = { updatedAt: fieldData.updatedAt, device: deviceId };
    }

    const firstFieldTime = Object.values(fields)[0]?.updatedAt || new Date().toISOString();

    return {
        id: change.docId,
        data,
        _fields: fields,
        updated_at: firstFieldTime,
        created_at: firstFieldTime,
        deleted_at: null,
        deleted_by: null,
    };
}

/** Infer a MIME type from a file extension. */
function guessMimeType(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    return MIME_TYPES[extension] || 'application/octet-stream';
}
