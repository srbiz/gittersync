/**
 * GitterSync — Configuration Resolution & Input Validation
 *
 * Every optional setting has exactly one default, declared here, so the sync
 * service and the API adapter can never drift apart. Also hosts the small
 * validators that protect the on-disk (repository) layout from malformed
 * collection names and paths.
 */

import type { GitHubSyncConfig, MigrationStep, SyncStatus } from './types';
import { ValidationError } from './types';

// ─── Defaults ──────────────────────────────────────────────────────────────

/** Default branch when none is configured */
export const DEFAULT_BRANCH = 'main';

/** Default compaction threshold — compact when this many changelog files exist */
export const DEFAULT_COMPACTION_THRESHOLD = 20;

/** Default maximum retry attempts on 409 Conflict */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base delay (ms) for exponential backoff */
export const DEFAULT_RETRY_BASE_DELAY = 1000;

/** Default soft-delete retention — 30 days */
export const DEFAULT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default per-request timeout — 30 seconds */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default raw content host */
export const DEFAULT_RAW_BASE_URL = 'https://raw.githubusercontent.com';

/**
 * GitHub's Contents API rejects files larger than 1 MiB.
 * Uploads above this limit fail with a clear {@link ValidationError} instead of
 * an opaque 422 from GitHub.
 */
export const MAX_CONTENT_API_BYTES = 1024 * 1024;

/** Default auto-sync interval — 5 minutes */
export const DEFAULT_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ─── Resolved Configuration ────────────────────────────────────────────────

/** A {@link GitHubSyncConfig} with every optional value filled in. */
export interface ResolvedGitHubSyncConfig {
    owner: string;
    repo: string;
    branch: string;
    compactionThreshold: number;
    maxRetries: number;
    retryBaseDelay: number;
    deleteRetentionMs: number;
    requestTimeoutMs: number;
    useRawContent: boolean;
    rawBaseUrl: string;
    rawCacheBust: boolean;
    onSyncStatusChange: (status: SyncStatus) => void;
    migrations: MigrationStep[];
}

const noopStatusListener = (): void => {};

/**
 * Fill in defaults and validate a user-supplied configuration.
 *
 * @param config - Partial configuration from the application
 * @returns A fully populated configuration object
 * @throws {ValidationError} If `owner`/`repo` are missing or a numeric option is invalid
 *
 * @example
 * ```typescript
 * const resolved = resolveConfig({ owner: 'me', repo: 'my-data' })
 * resolved.branch          // 'main'
 * resolved.useRawContent   // true
 * resolved.deleteRetentionMs // 2592000000 (30 days)
 * ```
 */
export function resolveConfig(config: GitHubSyncConfig): ResolvedGitHubSyncConfig {
    if (!config || typeof config !== 'object') {
        throw new ValidationError('config', 'Configuration object is required');
    }

    assertNonEmptyString(config.owner, 'owner');
    assertNonEmptyString(config.repo, 'repo');

    return {
        owner: config.owner.trim(),
        repo: config.repo.trim(),
        branch: (config.branch ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH,
        compactionThreshold: positiveInt(
            config.compactionThreshold,
            DEFAULT_COMPACTION_THRESHOLD,
            'compactionThreshold',
        ),
        maxRetries: positiveInt(config.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries', true),
        retryBaseDelay: positiveInt(
            config.retryBaseDelay,
            DEFAULT_RETRY_BASE_DELAY,
            'retryBaseDelay',
            true,
        ),
        deleteRetentionMs: positiveInt(
            config.deleteRetentionMs,
            DEFAULT_DELETE_RETENTION_MS,
            'deleteRetentionMs',
            true,
        ),
        requestTimeoutMs: positiveInt(
            config.requestTimeoutMs,
            DEFAULT_REQUEST_TIMEOUT_MS,
            'requestTimeoutMs',
        ),
        useRawContent: config.useRawContent ?? true,
        rawBaseUrl: (config.rawBaseUrl ?? DEFAULT_RAW_BASE_URL).replace(/\/+$/, ''),
        rawCacheBust: config.rawCacheBust ?? true,
        onSyncStatusChange: config.onSyncStatusChange ?? noopStatusListener,
        migrations: config.migrations ?? [],
    };
}

// ─── Validators ────────────────────────────────────────────────────────────

/**
 * Collection names become both a repository file (`collections/<name>.json`)
 * and an IndexedDB table (`col_<name>`), so they are restricted to a safe
 * subset of characters.
 */
export const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate a collection name.
 *
 * @param name - Candidate collection name
 * @throws {ValidationError} If the name is empty or contains unsafe characters
 */
export function assertValidCollectionName(name: string): void {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ValidationError('collection', 'Collection name must be a non-empty string');
    }
    if (!COLLECTION_NAME_PATTERN.test(name)) {
        throw new ValidationError(
            `collection "${name}"`,
            'Collection names must start with a letter or digit and contain only letters, digits, dots, underscores or hyphens (max 64 characters)',
        );
    }
}

/**
 * Validate a repository-relative path (e.g. `collections/users.json`).
 *
 * Rejects absolute paths, parent-directory traversal and control characters —
 * none of which can exist in a Git tree, and all of which would otherwise
 * produce a confusing 404 or, worse, a write outside the intended directory.
 *
 * @param path - Candidate path within the repository
 * @throws {ValidationError} If the path is unsafe
 */
export function assertValidRepoPath(path: string): void {
    if (typeof path !== 'string' || path.trim().length === 0) {
        throw new ValidationError('path', 'Path must be a non-empty string');
    }
    if (path.startsWith('/') || path.includes('\\')) {
        throw new ValidationError(path, 'Path must be relative to the repository root');
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new ValidationError(path, 'Path must not contain empty, "." or ".." segments');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(path)) {
        throw new ValidationError(path, 'Path must not contain control characters');
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function assertNonEmptyString(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError(field, `${field} is required and must be a non-empty string`);
    }
}

function positiveInt(
    value: number | undefined,
    fallback: number,
    field: string,
    allowZero = false,
): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(field, `${field} must be a finite number`);
    }
    const rounded = Math.floor(value);
    if (allowZero ? rounded < 0 : rounded < 1) {
        throw new ValidationError(
            field,
            `${field} must be ${allowZero ? 'zero or a positive integer' : 'a positive integer'}`,
        );
    }
    return rounded;
}
