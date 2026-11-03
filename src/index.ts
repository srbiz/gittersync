/**
 * GitterSync — GitHub as a Free Database Backend
 *
 * Offline-first sync with per-collection files, incremental changelogs,
 * and field-level conflict resolution.
 *
 * ### Entry points
 *
 * - {@link GitHubSyncService} — the orchestrator you instantiate per repository
 * - {@link LocalDB} — offline-first document store the UI reads/writes
 *   (reachable via `sync.getLocalDb()`)
 * - {@link GitHubApiAdapter} — low-level GitHub transport (raw + REST)
 * - `merge*` helpers — the conflict-resolution primitives
 * - `storeToken`/`retrieveToken` — encrypted PAT storage
 *
 * Full reference: `docs/api.md`.
 *
 * @packageDocumentation
 */

// Types
export type {
    SyncCursor,
    DeviceId,
    FieldMeta,
    FieldsMap,
    SyncedDocument,
    CollectionFile,
    ChangelogOp,
    FieldChange,
    ChangelogEntry,
    ChangelogFile,
    CollectionMeta,
    MetaFile,
    MigrationTransform,
    MigrationStep,
    ExportManifest,
    FileRef,
    SyncStatus,
    PullResult,
    SyncResult,
    PushResult,
    CompactionResult,
    RateLimitInfo,
    UploadableContent,
    ContentSource,
    FetchFileOptions,
    GitHubSyncConfig,
} from './types';

export { ConflictError, RateLimitError, AuthError, ValidationError } from './types';

// Version
export { LIBRARY_VERSION } from './version';

// Configuration defaults & validation
export {
    resolveConfig,
    assertValidCollectionName,
    assertValidRepoPath,
    COLLECTION_NAME_PATTERN,
    DEFAULT_BRANCH,
    DEFAULT_COMPACTION_THRESHOLD,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_BASE_DELAY,
    DEFAULT_DELETE_RETENTION_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_RAW_BASE_URL,
    DEFAULT_AUTO_SYNC_INTERVAL_MS,
    MAX_CONTENT_API_BYTES,
} from './config';
export type { ResolvedGitHubSyncConfig } from './config';

// Raw content transport (raw.githubusercontent.com)
export { RawContentClient } from './raw-content';
export type { RawContentConfig, RawContentStats, RawFetchOutcome } from './raw-content';

// Merge algorithms
export {
    mergeDocument,
    mergeCollection,
    applyChangelogToCollection,
    createDocument,
    createChangelogEntry,
    getExpiredDeletes,
} from './merge';

// GitHub API adapter
export { GitHubApiAdapter, utf8ToBase64, decodeBase64Utf8 } from './github-api';
export type { GitHubFileResult, CompareResult, WriteResult, ApiUsage } from './github-api';

// Local database
export { LocalDB, META_DB_NAME, COLLECTIONS_DB_NAME } from './local-db';
export type { LocalChangelogEntry, SyncMeta } from './local-db';

// Crypto / token security
export {
    encrypt as encryptToken,
    decrypt as decryptToken,
    storeToken,
    retrieveToken,
    hasStoredToken,
    clearStoredToken,
} from './crypto';
export type { EncryptedToken } from './crypto';

// Main sync service
export { GitHubSyncService } from './sync-service';
