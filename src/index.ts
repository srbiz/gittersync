/**
 * GitterSync — GitHub as a Free Database Backend
 *
 * Offline-first sync with per-collection files, incremental changelogs,
 * and field-level conflict resolution.
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
    FileRef,
    SyncStatus,
    PullResult,
    GitHubSyncConfig,
} from './types';

export { ConflictError, RateLimitError, AuthError, ValidationError } from './types';

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
export { GitHubApiAdapter } from './github-api';

// Local database
export { LocalDB } from './local-db';
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
