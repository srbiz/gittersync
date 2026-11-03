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

// ─── Schema Migrations ──────────────────────────────────────────────────────

/** A function that transforms a collection's documents during migration */
export type MigrationTransform = (
    collection: string,
    documents: Record<string, SyncedDocument>,
    meta: MetaFile,
) => Record<string, SyncedDocument>;

/** A single migration step that transforms documents from one schema version to the next */
export interface MigrationStep {
    /** Schema version this migration starts from */
    from: number;
    /** Schema version this migration produces */
    to: number;
    /** Human-readable description of what this migration does */
    description: string;
    /** Transform function applied to each collection's documents */
    transform: MigrationTransform;
}

// ─── Data Export/Import ─────────────────────────────────────────────────────

/** Metadata stored in the export ZIP manifest */
export interface ExportManifest {
    /** ISO 8601 timestamp of when the export was created */
    exportedAt: string;
    /** GitterSync library version that created the export */
    sourceVersion: string;
    /** List of collection names included in the export */
    collections: string[];
    /** Number of changelog files included */
    changelogCount: number;
    /** Number of binary files included */
    fileCount: number;
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
    /** Whether `init()` completed successfully */
    isInitialized: boolean;
    /** ISO 8601 timestamp of the last completed pull/push — null if never synced */
    lastSyncAt: string | null;
    /** Current sync cursor — null if never synced */
    cursor: SyncCursor | null;
    /** This device's identifier — empty string before `init()` */
    deviceId: DeviceId;
    /** Number of local changelog entries waiting to be pushed */
    pendingChanges: number;
    /** GitHub repo size in KB — null if unknown */
    repoSizeKb: number | null;
    /** Remaining GitHub API rate limit — null if unknown */
    rateLimitRemaining: number | null;
    /** ISO 8601 timestamp when the GitHub rate limit resets — null if unknown */
    rateLimitResetAt: string | null;
    /** Whether reads are currently served from raw.githubusercontent.com */
    rawContentActive: boolean;
}

// ─── Pull Result ───────────────────────────────────────────────────────────

/** Result type for a pull operation */
export type PullResult =
    | {
          type: 'full';
          collections: Record<string, CollectionFile>;
          meta: MetaFile | null;
          /** Remote documents merged into the local database */
          documentsMerged: number;
          /** Changelog operations applied on top of the collection files */
          changelogOps: number;
          /** Number of GitHub REST API calls consumed by this pull */
          apiCalls?: number;
          /** Number of reads served by raw.githubusercontent.com (free of rate limit) */
          rawReads?: number;
      }
    | {
          type: 'incremental';
          collections: Record<string, CollectionFile>;
          changelogs: ChangelogFile[];
          /** Remote documents merged into the local database */
          documentsMerged: number;
          /** Changelog operations applied */
          changelogOps: number;
          /** Number of GitHub REST API calls consumed by this pull */
          apiCalls?: number;
          /** Number of reads served by raw.githubusercontent.com (free of rate limit) */
          rawReads?: number;
      }
    | { type: 'none' };

/**
 * Result type for {@link GitHubSyncService.sync} — the pull outcome plus how
 * many local changelog entries were pushed.
 *
 * `pushed` is 0 when the sync was skipped because another operation was already
 * running, or when this device had nothing pending.
 */
export type SyncResult = PullResult & { pushed: number };

/** Result type for a push operation */
export interface PushResult {
    /** Number of local changelog entries that were uploaded */
    pushed: number;
    /** Remote changelog file that was written — null when nothing was pending */
    changelogPath: string | null;
    /** Whether compaction ran as part of this push */
    compacted: boolean;
    /** REST API calls consumed by this push (raw reads are not counted) */
    apiCalls: number;
    /** Reads served by raw.githubusercontent.com during this push */
    rawReads: number;
}

/** Result type for a compaction run */
export interface CompactionResult {
    /** Changelog files that were merged and removed */
    changelogsCompacted: number;
    /** Collections that were rewritten */
    collectionsWritten: string[];
    /** Soft-deleted documents that were purged permanently */
    purgedDeletes: number;
    /** REST API calls consumed by this compaction */
    apiCalls: number;
}

/** Rate limit / transport information for status UIs */
export interface RateLimitInfo {
    /** Remaining REST API calls in the current window — null if unknown */
    remaining: number | null;
    /** ISO 8601 timestamp when the window resets — null if unknown */
    resetAt: string | null;
    /** REST API calls performed by this service instance */
    apiCalls: number;
    /** Reads served by raw.githubusercontent.com (these were free) */
    rawReads: number;
    /** Raw reads that reported "file does not exist" (also free) */
    rawMisses: number;
    /** Raw reads that had to fall back to the REST API */
    rawFallbacks: number;
    /** Whether raw reads are enabled and usable right now */
    rawContentActive: boolean;
}

/** Accepted payloads for {@link GitHubSyncService.uploadFile} */
export type UploadableContent = string | Blob | ArrayBuffer | Uint8Array;

// ─── Content Transport ─────────────────────────────────────────────────────

/**
 * Where the bytes of a file read came from.
 *
 * - `api` — GitHub REST API (`/repos/{owner}/{repo}/contents/{path}`).
 *   Counts against the hourly rate limit but is always authoritative and
 *   returns the blob SHA.
 * - `raw` — `raw.githubusercontent.com`. Does **not** count against the REST
 *   API rate limit, but is CDN-cached and cannot return a blob SHA.
 */
export type ContentSource = 'api' | 'raw';

/** Per-call overrides for file reads. */
export interface FetchFileOptions {
    /**
     * Bypass raw.githubusercontent.com and always use the REST API.
     *
     * Use this for write-critical reads (e.g. the collection file about to be
     * rewritten by a compaction) where a CDN-cached copy could cause a lost
     * update.
     */
    forceApi?: boolean;
}

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
    /**
     * How long soft-deleted documents are kept before compaction purges them —
     * defaults to 30 days. Purging too early can resurrect deleted documents on
     * devices that have not synced in a while.
     */
    deleteRetentionMs?: number;
    /** Per-request timeout in ms for raw content and REST calls — defaults to 30000 */
    requestTimeoutMs?: number;
    /**
     * Read file contents from `raw.githubusercontent.com` instead of the REST API.
     *
     * Raw reads do **not** count against the GitHub REST rate limit
     * (5,000 requests/hour authenticated, 60/hour anonymous), which is by far
     * the scarcest resource when using a repository as a database. GitterSync
     * appends a cache-busting query parameter and transparently falls back to
     * the REST API whenever raw content is unavailable (private repo without a
     * usable token, CORS block, non-200 response, invalid JSON).
     *
     * Defaults to `true`. Set to `false` if you need strict read-after-write
     * consistency from the REST API for every read.
     */
    useRawContent?: boolean;
    /** Raw content host — defaults to 'https://raw.githubusercontent.com' */
    rawBaseUrl?: string;
    /** Append a cache-busting query parameter to raw URLs — defaults to true */
    rawCacheBust?: boolean;
    /** Callback for sync status changes — used by UI */
    onSyncStatusChange?: (status: SyncStatus) => void;
    /** Schema migration steps — run on pull when remote schemaVersion > local */
    migrations?: MigrationStep[];
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
