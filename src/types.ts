/**
 * GitterSync — Core Types
 *
 * All shared interfaces and type definitions for the sync system.
 */

// ─── Sync Cursor ──────────────────────────────────────────────────────────

/** Tracks the last known GitHub commit SHA for incremental sync */
export interface SyncCursor {
    /** GitHub commit SHA */
    sha: string;
    /** ISO 8601 timestamp of when this cursor was saved */
    timestamp: string;
}

// ─── Device Identity ───────────────────────────────────────────────────────

/** Unique device identifier, generated once on first app run */
export type DeviceId = string;

// ─── Field-Level Metadata ──────────────────────────────────────────────────

/** Metadata for a single field within a document — used for field-level LWW */
export interface FieldMeta {
    /** ISO 8601 timestamp of when this field was last updated */
    updatedAt: string;
    /** Device that made the change */
    device: DeviceId;
}

/** Map of field names to their metadata */
export type FieldsMap = Record<string, FieldMeta>;

// ─── Document ──────────────────────────────────────────────────────────────

/**
 * A synced document with field-level tracking.
 *
 * Generic parameter T is the app-specific data shape.
 * The sync metadata lives in `_fields` and `deleted_at`.
 */
export interface SyncedDocument<T = Record<string, unknown>> {
    /** Unique document identifier */
    id: string;
    /** Application data fields */
    data: T;
    /** Per-field sync metadata */
    _fields: FieldsMap;
    /** Document-level last update timestamp (max of all field timestamps) */
    updated_at: string;
    /** Document creation timestamp */
    created_at: string;
    /** Soft-delete timestamp — null if not deleted */
    deleted_at: string | null;
    /** Device that performed the deletion */
    deleted_by: DeviceId | null;
}

// ─── Collection File ───────────────────────────────────────────────────────

/** Format of a `collections/{name}.json` file stored in GitHub */
export interface CollectionFile<T = Record<string, unknown>> {
    /** Collection name */
    collection: string;
    /** Monotonically increasing version — incremented on each compaction */
    version: number;
    /** ISO 8601 timestamp of the last compaction */
    updatedAt: string;
    /** Documents indexed by ID for O(1) lookups during merge */
    documents: Record<string, SyncedDocument<T>>;
}

// ─── Changelog ────────────────────────────────────────────────────────────

/** Operation type for a changelog entry */
export type ChangelogOp = 'create' | 'update' | 'delete';

/** A single field change within a changelog entry */
export interface FieldChange {
    /** New value of the field */
    value: unknown;
    /** ISO 8601 timestamp of when this field was changed */
    updatedAt: string;
}

/** A single document-level change within a changelog file */
export interface ChangelogEntry {
    /** Collection name */
    collection: string;
    /** Document ID */
    docId: string;
    /** Operation type */
    op: ChangelogOp;
    /** Field changes — present for create and update ops */
    fields?: Record<string, FieldChange>;
    /** Deletion timestamp — present for delete op */
    deletedAt?: string;
}

/** Format of a `changelog/{timestamp}_{deviceId}.json` file stored in GitHub */
export interface ChangelogFile {
    /** Device that produced these changes */
    deviceId: DeviceId;
    /** ISO 8601 timestamp of this changelog batch */
    timestamp: string;
    /** Ordered list of changes */
    changes: ChangelogEntry[];
}

// ─── Meta ──────────────────────────────────────────────────────────────────

/** Collection metadata entry in meta.json */
export interface CollectionMeta {
    /** Last compacted version */
    version: number;
    /** Git blob SHA of the collection file */
    sha: string;
}

/** Format of `meta.json` stored in GitHub */
export interface MetaFile {
    /** Schema version — incremented on breaking data format changes */
    schemaVersion: number;
    /** Per-collection metadata */
    collections: Record<string, CollectionMeta>;
    /** Number of un-compacted changelog entries */
    changelogCount: number;
}

// ─── File References ───────────────────────────────────────────────────────

/** Metadata for a binary file stored in the `files/` directory */
export interface FileRef {
    /** Path within the repo — e.g., `files/doc_abc123.pdf` */
    path: string;
    /** Git blob SHA of the file */
    sha: string;
    /** File size in bytes */
    size: number;
    /** MIME type */
    mimeType: string;
}

// ─── Sync Status ──────────────────────────────────────────────────────────

/** Current state of the sync engine — exposed to the UI */
export interface SyncStatus {
    /** Whether a sync operation is currently in progress */
    isSyncing: boolean;
    /** Whether the browser reports an active network connection */
    isOnline: boolean;
    /** Current sync cursor — null if never synced */
    cursor: SyncCursor | null;
    /** This device's identifier */
    deviceId: DeviceId;
    /** Number of local changelog entries waiting to be pushed */
    pendingChanges: number;
    /** GitHub repo size in KB — null if unknown */
    repoSizeKb: number | null;
    /** Remaining GitHub API rate limit — null if unknown */
    rateLimitRemaining: number | null;
}

// ─── Pull Result ───────────────────────────────────────────────────────────

/** Result type for a pull operation */
export type PullResult =
    | { type: 'full'; collections: Record<string, CollectionFile>; meta: MetaFile | null }
    | {
          type: 'incremental';
          collections: Record<string, CollectionFile>;
          changelogs: ChangelogFile[];
      }
    | { type: 'none' };

// ─── Configuration ─────────────────────────────────────────────────────────

/** Configuration for the GitHubSyncService */
export interface GitHubSyncConfig {
    /** GitHub repository owner (username or org) */
    owner: string;
    /** GitHub repository name */
    repo: string;
    /** Branch name — defaults to 'main' */
    branch?: string;
    /** Number of changelog entries before triggering compaction — defaults to 20 */
    compactionThreshold?: number;
    /** Maximum number of retry attempts on 409 Conflict — defaults to 3 */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff — defaults to 1000 */
    retryBaseDelay?: number;
    /** Callback for sync status changes — used by UI */
    onSyncStatusChange?: (status: SyncStatus) => void;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** Error thrown when GitHub returns 409 Conflict */
export class ConflictError extends Error {
    constructor(
        public readonly path: string,
        public readonly attempt: number,
    ) {
        super(`Conflict on ${path} (attempt ${attempt})`);
        this.name = 'ConflictError';
    }
}

/** Error thrown when GitHub rate limit is exhausted */
export class RateLimitError extends Error {
    constructor(
        public readonly resetAt: Date,
        public readonly remaining: number,
    ) {
        super(`Rate limit exhausted. Resets at ${resetAt.toISOString()}`);
        this.name = 'RateLimitError';
    }
}

/** Error thrown when authentication fails */
export class AuthError extends Error {
    constructor(public readonly status: number) {
        super(`Authentication failed (HTTP ${status})`);
        this.name = 'AuthError';
    }
}

/** Error thrown when data validation fails */
export class ValidationError extends Error {
    constructor(
        public readonly path: string,
        public readonly reason: string,
    ) {
        super(`Validation failed for ${path}: ${reason}`);
        this.name = 'ValidationError';
    }
}
