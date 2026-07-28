/**
 * GitterSync — GitHub Sync Service
 *
 * The main orchestrator that coordinates:
 * - Pull from GitHub (full or incremental via Compare Commits API)
 * - Push local changes as changelog entries
 * - Compaction of changelogs into collection files
 * - File upload/download with files-first ordering
 * - Field-level LWW merge using the merge module
 */

import JSZip from 'jszip';
import { GitHubApiAdapter } from './github-api';
import { LocalDB } from './local-db';
import { mergeDocument, applyChangelogToCollection, getExpiredDeletes } from './merge';
import type {
    GitHubSyncConfig,
    SyncStatus,
    SyncCursor,
    PullResult,
    ChangelogEntry,
    ChangelogFile,
    CollectionFile,
    MetaFile,
    MigrationStep,
    ExportManifest,
    SyncedDocument,
    DeviceId,
    FileRef,
} from './types';
import { ConflictError, AuthError, ValidationError } from './types';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Default compaction threshold — compact when this many changelog files exist */
const DEFAULT_COMPACTION_THRESHOLD = 20;

/** Default maximum retry attempts on 409 Conflict */
const DEFAULT_MAX_RETRIES = 3;

/** Soft-delete purge age — 30 days in milliseconds */
const PURGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── GitHubSyncService ─────────────────────────────────────────────────────

/**
 * Main sync service — coordinates between the local database (Dexie)
 * and the remote GitHub repository.
 *
 * Usage:
 * ```typescript
 * const sync = new GitHubSyncService({ owner: 'myuser', repo: 'my-app-db' })
 * await sync.init('ghp_xxxx')
 * await sync.registerCollections(['users', 'documents', 'cases'])
 * const result = await sync.pull()
 * // ... user makes changes ...
 * await sync.push()
 * ```
 */
export class GitHubSyncService {
    private api: GitHubApiAdapter;
    private localDb: LocalDB;
    private config: Required<GitHubSyncConfig>;
    private isSyncing = false;
    private syncTimer: ReturnType<typeof setTimeout> | null = null;
    private token: string | null = null;
    private online = typeof navigator !== 'undefined' && navigator.onLine;
    private boundOnlineHandler: (() => void) | null = null;
    private boundOfflineHandler: (() => void) | null = null;

    constructor(config: GitHubSyncConfig) {
        this.config = {
            owner: config.owner,
            repo: config.repo,
            branch: config.branch ?? 'main',
            compactionThreshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
            retryBaseDelay: config.retryBaseDelay ?? 1000,
            onSyncStatusChange: config.onSyncStatusChange ?? (() => {}),
            migrations: config.migrations ?? [],
        };

        this.api = new GitHubApiAdapter(config);
        this.localDb = new LocalDB();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    /**
     * Initialize the sync service with a GitHub token.
     *
     * @param token - GitHub PAT or OAuth token
     */
    async init(token: string): Promise<boolean> {
        this.token = token;

        // Initialize GitHub API adapter
        await this.api.init(token);

        // Initialize local database
        await this.localDb.init();

        this.emitStatus();
        return true;
    }

    /**
     * Register collections that this app uses.
     * Must be called after init() and before any read/write operations.
     */
    async registerCollections(names: string[]): Promise<void> {
        for (const name of names) {
            await this.localDb.registerCollection(name);
        }
    }

    // ─── Pull ───────────────────────────────────────────────────────────

    /**
     * Pull changes from GitHub.
     *
     * - If no sync cursor exists: performs a full pull of all collection files.
     * - If a sync cursor exists: uses Compare Commits API to detect changes,
     *   then downloads only the changed files.
     */
    async pull(): Promise<PullResult> {
        this.ensureInitialized();
        this.setSyncing(true);

        try {
            const cursor = await this.localDb.getSyncCursor();

            if (!cursor) {
                return await this.fullPull();
            } else {
                return await this.incrementalPull(cursor);
            }
        } finally {
            this.setSyncing(false);
        }
    }

    /**
     * Full pull — download all collection files and changelogs.
     * Used on first sync or when the cursor is invalid.
     */
    private async fullPull(): Promise<PullResult> {
        // 1. Download meta.json
        const metaResult = await this.api.fetchJsonFile<MetaFile>('meta.json');
        const meta = metaResult?.content as MetaFile | null;

        // 2. Determine which collections exist
        const collectionNames = meta
            ? Object.keys(meta.collections)
            : await this.guessCollectionNames();

        if (collectionNames.length === 0) {
            // Empty repo — nothing to pull
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
        const changelogFiles = await this.api.listDirectory('changelog');
        const changelogs: ChangelogFile[] = [];
        for (const filename of changelogFiles) {
            const result = await this.api.fetchJsonFile<ChangelogFile>(`changelog/${filename}`);
            if (result) {
                changelogs.push(result.content as ChangelogFile);
            }
        }

        // 6. Merge into local database
        for (const [name, collectionFile] of Object.entries(collections)) {
            await this.mergeCollectionFileToLocal(name, collectionFile);
        }

        // Apply changelogs on top
        for (const changelog of changelogs) {
            await this.applyChangelogToLocal(changelog);
        }

        // 7. Update sync cursor
        const headSha = await this.api.getLatestCommitSha();
        await this.localDb.setSyncCursor({
            sha: headSha,
            timestamp: new Date().toISOString(),
        });

        this.emitStatus();
        return { type: 'full', collections, meta };
    }

    /**
     * Incremental pull — only download files that changed since the cursor.
     */
    private async incrementalPull(cursor: SyncCursor): Promise<PullResult> {
        // 1. Compare commits to find changed files
        const comparison = await this.api.compareCommits(cursor.sha);

        if (comparison.status === 'identical') {
            return { type: 'none' };
        }

        // 1.5. Fetch meta.json for migration check
        const metaResult = await this.api.fetchJsonFile<MetaFile>('meta.json');
        const meta = metaResult?.content as MetaFile | null;

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
        for (const [name, collectionFile] of Object.entries(changedCollections)) {
            await this.mergeCollectionFileToLocal(name, collectionFile);
        }

        for (const changelog of changelogs) {
            await this.applyChangelogToLocal(changelog);
        }

        // 4. Update sync cursor
        const headSha = await this.api.getLatestCommitSha();
        await this.localDb.setSyncCursor({
            sha: headSha,
            timestamp: new Date().toISOString(),
        });

        this.emitStatus();
        return { type: 'incremental', collections: changedCollections, changelogs };
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
     * Batches all pending entries into a single changelog file,
     * then checks if compaction is needed.
     */
    async push(): Promise<void> {
        this.ensureInitialized();
        this.setSyncing(true);

        try {
            // 1. Get pending changelog entries
            const entries = await this.localDb.getPendingChangelogEntries();

            if (entries.length === 0) {
                return; // Nothing to push
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
            await this.api.createOrUpdateFileWithRetry(
                fileName,
                JSON.stringify(changelogFile, null, 2),
                `Sync ${entries.length} changes from ${deviceId}`,
            );

            // 4. Clear pushed entries from local queue
            const localIds = entries.filter((e) => e.localId !== undefined).map((e) => e.localId!);
            await this.localDb.clearChangelogEntries(localIds);

            // 5. Update sync cursor
            const headSha = await this.api.getLatestCommitSha();
            await this.localDb.setSyncCursor({
                sha: headSha,
                timestamp: new Date().toISOString(),
            });

            // 6. Check if compaction is needed
            const changelogFiles = await this.api.listDirectory('changelog');
            if (changelogFiles.length >= this.config.compactionThreshold) {
                await this.compact();
            }

            this.emitStatus();
        } finally {
            this.setSyncing(false);
        }
    }

    // ─── Full Sync ──────────────────────────────────────────────────────

    /**
     * Perform a full sync: pull remote changes, then push local changes.
     */
    async sync(): Promise<PullResult> {
        if (this.isSyncing) {
            console.warn('[GitterSync] Sync skipped — already in progress');
            return { type: 'none' };
        }

        try {
            const pullResult = await this.pull();
            await this.push();
            return pullResult;
        } catch (error) {
            if (error instanceof ConflictError) {
                // Retry the entire sync
                console.warn(`[GitterSync] Conflict during sync, retrying...`);
                return this.sync();
            }
            throw error;
        }
    }

    // ─── Compaction ─────────────────────────────────────────────────────

    /**
     * Compact changelog entries into collection files.
     *
     * This reads all changelog entries from GitHub, applies them to the
     * corresponding collection files, and deletes the applied entries.
     */
    async compact(): Promise<void> {
        this.ensureInitialized();

        // 1. Get all changelog files
        const changelogFiles = await this.api.listDirectory('changelog');
        if (changelogFiles.length === 0) return;

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
        for (const [collectionName, changes] of Object.entries(changesByCollection)) {
            const result = await this.api.fetchJsonFile<CollectionFile>(
                `collections/${collectionName}.json`,
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
            const expiredIds = getExpiredDeletes(merged.documents, PURGE_AGE_MS);
            for (const id of expiredIds) {
                delete merged.documents[id];
            }

            // Push updated collection file
            await this.api.createOrUpdateFileWithRetry(
                `collections/${collectionName}.json`,
                JSON.stringify(merged, null, 2),
                `Compact: merge ${changes.length} changes into ${collectionName}`,
            );
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
        const headSha = await this.api.getLatestCommitSha();
        await this.localDb.setSyncCursor({
            sha: headSha,
            timestamp: new Date().toISOString(),
        });

        this.emitStatus();
    }

    // ─── File Storage ──────────────────────────────────────────────────

    /**
     * Upload a binary file to GitHub.
     *
     * Uses files-first ordering: the file is uploaded BEFORE any
     * metadata references are created. If the metadata update fails,
     * the orphaned file is harmless.
     *
     * @param filePath - Path within the repo — e.g., 'files/doc_abc123.pdf'
     * @param base64Content - Base64-encoded file content
     * @param message - Commit message
     * @returns File reference metadata
     */
    async uploadFile(filePath: string, base64Content: string, message: string): Promise<FileRef> {
        this.ensureInitialized();

        const sha = await this.api.uploadBinaryFile(filePath, base64Content, message);

        // Estimate size from base64 content
        const size = Math.ceil(base64Content.length * 0.75);

        // Extract MIME type from file extension
        const extension = filePath.split('.').pop()?.toLowerCase() || '';
        const mimeTypeMap: Record<string, string> = {
            pdf: 'application/pdf',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        const mimeType = mimeTypeMap[extension] || 'application/octet-stream';

        return {
            path: filePath,
            sha,
            size,
            mimeType,
        };
    }

    /**
     * Download a binary file from GitHub.
     */
    async downloadFile(filePath: string): Promise<Blob> {
        this.ensureInitialized();

        if (!this.token) {
            throw new Error('Not authenticated');
        }

        return this.api.downloadBinaryFile(filePath);
    }

    // ─── Data Export/Import ────────────────────────────────────────────

    /**
     * Export all data from GitHub as a ZIP file.
     *
     * Fetches meta.json, all collection files, changelogs, and binary files
     * from the remote repository and packages them into a downloadable ZIP.
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

        // 5. Fetch binary files
        let fileCount = 0;
        const binaryFiles = await this.api.listDirectory('files');
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
            sourceVersion: '1.3.1',
            collections: collectionNames,
            changelogCount,
            fileCount,
        };
        folder.file('manifest.json', JSON.stringify(manifest, null, 2));

        // 7. Generate ZIP blob
        return folder.generateAsync({ type: 'blob' });
    }

    /**
     * Import data from a ZIP file, replacing local data.
     *
     * Parses the ZIP, validates its structure, replaces local collection data,
     * clears the sync cursor (to force a full re-sync on next pull), and updates
     * the local schema version if meta.json contains one.
     *
     * @param file - The ZIP file to import (as File or Blob)
     * @throws {ValidationError} If the file is not a valid ZIP or has invalid structure
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
        this.emitStatus();
    }

    // ─── Auto Sync ─────────────────────────────────────────────────────

    /**
     * Start automatic sync with a given interval.
     *
     * @param intervalMs - Sync interval in milliseconds (default: 5 minutes)
     */
    startAutoSync(intervalMs = 5 * 60 * 1000): void {
        this.stopAutoSync();

        const doSync = async () => {
            if (!this.online) {
                return; // Skip sync cycle when offline
            }
            try {
                await this.sync();
            } catch (error) {
                console.error('[GitterSync] Auto-sync failed:', error);
            }
        };

        // Register online/offline event listeners
        if (typeof window !== 'undefined') {
            this.boundOnlineHandler = () => {
                this.online = true;
                this.emitStatus();
                // Trigger an immediate sync when connectivity returns
                doSync();
            };
            this.boundOfflineHandler = () => {
                this.online = false;
                this.emitStatus();
            };
            window.addEventListener('online', this.boundOnlineHandler);
            window.addEventListener('offline', this.boundOfflineHandler);
        }

        // Initial sync (if online)
        doSync();

        // Set up interval
        this.syncTimer = setInterval(doSync, intervalMs);
    }

    /**
     * Stop automatic sync.
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

    /**
     * Whether the browser reports an active network connection.
     * Defaults to `true` in non-browser environments.
     */
    get isOnline(): boolean {
        return this.online;
    }

    // ─── Status ─────────────────────────────────────────────────────────

    /**
     * Get the current sync status.
     */
    getStatus(): SyncStatus {
        return {
            isSyncing: this.isSyncing,
            isOnline: this.online,
            cursor: null, // Will be populated async
            deviceId: this.localDb.getDeviceId(),
            pendingChanges: 0, // Will be populated async
            repoSizeKb: this.api.rateLimitRemaining !== null ? null : null,
            rateLimitRemaining: this.api.rateLimitRemaining,
        };
    }

    /**
     * Get the full sync status (async — includes data from the database).
     */
    async getFullStatus(): Promise<SyncStatus> {
        const cursor = await this.localDb.getSyncCursor();
        const pendingChanges = await this.localDb.getPendingChangelogCount();

        let repoSizeKb: number | null = null;
        try {
            repoSizeKb = await this.api.getRepoSize();
        } catch {
            // Non-critical
        }

        return {
            isSyncing: this.isSyncing,
            isOnline: this.online,
            cursor,
            deviceId: this.localDb.getDeviceId(),
            pendingChanges,
            repoSizeKb,
            rateLimitRemaining: this.api.rateLimitRemaining,
        };
    }

    // ─── Local Database Access ──────────────────────────────────────────

    /**
     * Get the local database instance for direct document access.
     */
    getLocalDb(): LocalDB {
        return this.localDb;
    }

    // ─── Private Helpers ────────────────────────────────────────────────

    /**
     * Merge a remote collection file into the local database.
     * Uses field-level LWW merge for documents that exist on both sides.
     */
    private async mergeCollectionFileToLocal(
        collectionName: string,
        collectionFile: CollectionFile,
    ): Promise<void> {
        const remoteDocs = collectionFile.documents as Record<string, SyncedDocument>;

        await this.localDb.mergeDocuments(collectionName, remoteDocs, (localDoc, remoteDoc) =>
            mergeDocument(localDoc, remoteDoc),
        );
    }

    /**
     * Apply a remote changelog file to the local database.
     */
    private async applyChangelogToLocal(changelog: ChangelogFile): Promise<void> {
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
                    const newData: Record<string, unknown> = {};
                    const newFields: Record<string, { updatedAt: string; device: string }> = {};

                    for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
                        newData[fieldName] = fieldData.value;
                        newFields[fieldName] = { updatedAt: fieldData.updatedAt, device: deviceId };
                    }

                    const firstFieldTime =
                        Object.values(newFields)[0]?.updatedAt || new Date().toISOString();

                    const doc: SyncedDocument = {
                        id: change.docId,
                        data: newData,
                        _fields: newFields,
                        updated_at: firstFieldTime,
                        created_at: firstFieldTime,
                        deleted_at: null,
                        deleted_by: null,
                    };

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
                    if (!existing) continue;

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
                    if (!existing) continue;

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
    }

    /**
     * Push an updated meta.json to GitHub.
     */
    private async pushMetaUpdate(): Promise<void> {
        const collectionNames = this.localDb.getRegisteredCollections();
        const collections: Record<string, { version: number; sha: string }> = {};

        for (const name of collectionNames) {
            const result = await this.api.fetchJsonFile(`collections/${name}.json`);
            collections[name] = {
                version: (result?.content as any)?.version ?? 0,
                sha: result?.sha ?? '',
            };
        }

        const meta: MetaFile = {
            schemaVersion: await this.localDb.getSchemaVersion(),
            collections,
            changelogCount: 0, // Just compacted
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

    private setSyncing(value: boolean): void {
        this.isSyncing = value;
        this.emitStatus();
    }

    private emitStatus(): void {
        try {
            this.config.onSyncStatusChange(this.getStatus());
        } catch {
            // Callback errors should not break sync
        }
    }
}
