/**
 * GitterSync — GitHub API Adapter
 *
 * Low-level wrapper around GitHub's Content API, Compare Commits API and the
 * raw CDN endpoint. Handles base64 encoding, blob SHA tracking, rate limit
 * monitoring and the raw/API read split.
 *
 * ### Request budget
 *
 * Every method documents how many REST API calls it consumes, because the hourly
 * rate limit (5,000 authenticated / 60 anonymous) is the scarcest resource when
 * a repository is used as a database. Reads go through
 * `raw.githubusercontent.com` whenever possible (see {@link RawContentClient}),
 * which does not count against that budget, and blob SHAs are cached so writes
 * normally need a single request instead of two.
 */

import { Octokit } from '@octokit/rest';
import type { GitHubSyncConfig, ContentSource, FetchFileOptions } from './types';
import { ConflictError, RateLimitError, AuthError, ValidationError } from './types';
import { resolveConfig, type ResolvedGitHubSyncConfig } from './config';
import { assertValidRepoPath, MAX_CONTENT_API_BYTES } from './config';
import { RawContentClient, type RawContentStats } from './raw-content';

// ─── Constants ─────────────────────────────────────────────────────────────

/** GitHub truncates a comparison beyond this many commits. */
const COMPARE_COMMIT_LIMIT = 250;

/** GitHub truncates the file list of a comparison at this many entries. */
const COMPARE_FILE_LIMIT = 300;

// ─── Public Result Types ───────────────────────────────────────────────────

/**
 * Result of a file read from GitHub.
 */
export interface GitHubFileResult<T = unknown> {
    /** Decoded JSON content */
    content: T;
    /**
     * Git blob SHA of the file.
     *
     * Empty string when the file was served by `raw.githubusercontent.com` and
     * has never been read through the REST API — raw responses do not carry a
     * SHA. Callers that need an authoritative SHA must pass
     * `{ forceApi: true }`.
     */
    sha: string;
    /** Which transport produced this read */
    source: ContentSource;
}

/**
 * Result of a compare commits operation.
 */
export interface CompareResult {
    /** 'identical' | 'ahead' | 'behind' | 'diverged' */
    status: string;
    /** List of changed file paths */
    changedFiles: string[];
    /**
     * Latest commit SHA.
     *
     * Derived from the compare payload itself when GitHub reports `ahead` or
     * `identical`, which saves a separate `listCommits` call. Falls back to the
     * base SHA when the head cannot be determined.
     */
    headSha: string;
    /** Commits the head is ahead of the base by */
    aheadBy: number;
    /** Commits the head is behind the base by */
    behindBy: number;
}

/**
 * Result of a successful file write.
 */
export interface WriteResult {
    /** Path that was written */
    path: string;
    /** Git blob SHA of the new file content */
    blobSha: string;
    /** Commit SHA created by the write — `null` when GitHub did not report one */
    commitSha: string | null;
    /** Parent commit SHAs of the new commit — used to detect concurrent writes */
    parentShas: string[];
}

/**
 * Transport counters — how work was split between the REST API and raw content.
 */
export interface ApiUsage {
    /** REST API requests performed (these count against the rate limit) */
    apiCalls: number;
    /** Reads served by raw.githubusercontent.com */
    rawReads: number;
    /** Raw reads that reported "file does not exist" */
    rawMisses: number;
    /** Raw reads that had to fall back to the REST API */
    rawFallbacks: number;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

/**
 * GitHub API adapter — wraps Octokit calls with GitterSync-specific logic.
 *
 * @example
 * ```typescript
 * const api = new GitHubApiAdapter({ owner: 'me', repo: 'my-data' })
 * await api.init(process.env.GITHUB_TOKEN!)
 *
 * const users = await api.fetchJsonFile<CollectionFile>('collections/users.json')
 * if (users) console.log(users.source, users.content)   // 'raw' | 'api'
 *
 * await api.createOrUpdateFileWithRetry('meta.json', '{}', 'Update meta')
 * ```
 */
export class GitHubApiAdapter {
    private octokit: Octokit | null = null;
    private readonly config: ResolvedGitHubSyncConfig;
    private readonly raw: RawContentClient;
    private token: string | null = null;

    /** path → blob SHA, learned from reads and writes; avoids a GET before each PUT */
    private readonly shaCache = new Map<string, string>();

    /** Last commit produced by a write — lets callers advance a cursor for free */
    private lastCommit: { sha: string; parentShas: string[] } | null = null;

    private apiCalls = 0;
    private isPrivateRepo: boolean | null = null;
    private cachedRepoSizeKb: number | null = null;
    private lastRateLimitWarningAt = 0;

    /**
     * @param config - Repository coordinates and tuning options. All optional
     * fields are resolved to their documented defaults (see {@link resolveConfig}).
     */
    constructor(config: GitHubSyncConfig) {
        this.config = resolveConfig(config);
        this.raw = new RawContentClient({
            owner: this.config.owner,
            repo: this.config.repo,
            ref: this.config.branch,
            token: null,
            baseUrl: this.config.rawBaseUrl,
            cacheBust: this.config.rawCacheBust,
            timeoutMs: this.config.requestTimeoutMs,
        });
        if (!this.config.useRawContent) {
            this.raw.disable('raw content disabled via useRawContent: false');
        }
    }

    // ─── Initialization ───────────────────────────────────────────────────

    /**
     * Initialize the adapter with a GitHub token.
     *
     * Verifies repo access by fetching the repo metadata (1 REST call). The
     * response also reveals whether the repository is private, which decides if
     * raw reads can be anonymous.
     *
     * @param token - GitHub personal access token (classic `repo` scope, or a
     * fine-grained token with Contents read/write)
     * @returns `true` when the repository is reachable
     * @throws {AuthError} On HTTP 401/403
     * @throws {RateLimitError} When the rate limit is already exhausted
     * @throws {Error} When the repository cannot be reached for another reason
     */
    async init(token: string): Promise<boolean> {
        if (typeof token !== 'string' || token.trim().length === 0) {
            throw new ValidationError('token', 'A GitHub token is required');
        }

        this.token = token;
        this.raw.setToken(token);
        this.octokit = new Octokit({
            auth: token,
            request: { timeout: this.config.requestTimeoutMs },
        });

        this.octokit.hook.after('request', async (response) => {
            const headers = response.headers as Record<string, string>;
            const remaining = headers['x-ratelimit-remaining'];
            const resetAt = headers['x-ratelimit-reset'];
            if (remaining) this.rateLimitRemaining = parseInt(remaining, 10);
            if (resetAt) this.rateLimitResetAt = new Date(parseInt(resetAt, 10) * 1000);
            this.warnIfRateLimitLow();
        });

        try {
            this.track();
            const { data } = await this.octokit.repos.get({
                owner: this.config.owner,
                repo: this.config.repo,
            });
            if (typeof data.private === 'boolean') {
                this.isPrivateRepo = data.private;
                this.raw.setRepoVisibility(data.private);
            }
            if (typeof data.size === 'number') {
                this.cachedRepoSizeKb = data.size;
            }
            return true;
        } catch (error: any) {
            throw this.classifyError(
                error,
                `Failed to access repo ${this.config.owner}/${this.config.repo}`,
            );
        }
    }

    // ─── File Reads ───────────────────────────────────────────────────────

    /**
     * Fetch and decode a JSON file from the repo.
     *
     * Tries `raw.githubusercontent.com` first (free of rate limit) and falls
     * back to the REST API automatically.
     *
     * **Cost:** 0 REST calls when raw serves the read, otherwise 1.
     *
     * @param path - Path relative to the repository root, e.g. `collections/users.json`
     * @param options - Set `forceApi: true` for write-critical reads that must
     * not come from a CDN cache and must carry an authoritative blob SHA
     * @returns The decoded content plus its blob SHA, or `null` when the file
     * does not exist
     * @throws {AuthError} On HTTP 401/403 from the REST API
     * @throws {RateLimitError} When the REST rate limit is exhausted
     * @throws {ValidationError} When the path points at a directory
     */
    async fetchJsonFile<T = unknown>(
        path: string,
        options: FetchFileOptions = {},
    ): Promise<GitHubFileResult<T> | null> {
        this.ensureInitialized();
        assertValidRepoPath(path);

        // 1. Raw channel — no rate limit cost.
        if (!options.forceApi && this.raw.available) {
            const outcome = await this.raw.fetchJson<T>(path);
            if (outcome.status === 'ok') {
                return {
                    content: outcome.value,
                    sha: this.shaCache.get(path) ?? '',
                    source: 'raw',
                };
            }
            if (outcome.status === 'missing') return null;
            // 'unavailable' → fall through to the REST API.
        }

        // 2. REST API — authoritative, returns the blob SHA.
        this.assertRateLimitBudget();

        try {
            this.track();
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });

            if (!('content' in data)) {
                throw new ValidationError(path, 'Expected file content but got directory listing');
            }

            const decoded = JSON.parse(atob(data.content));
            this.shaCache.set(path, data.sha);
            return { content: decoded as T, sha: data.sha, source: 'api' };
        } catch (error: any) {
            if (error.status === 404) {
                this.shaCache.delete(path);
                return null;
            }
            throw this.classifyError(error, `Failed to read ${path}`);
        }
    }

    /**
     * Fetch a file as plain text (0 REST calls when raw serves it).
     *
     * @param path - Path relative to the repository root
     * @param options - Set `forceApi: true` to bypass the raw channel
     * @returns The file text, or `null` when the file does not exist
     */
    async fetchTextFile(
        path: string,
        options: FetchFileOptions = {},
    ): Promise<{ text: string; source: ContentSource } | null> {
        this.ensureInitialized();
        assertValidRepoPath(path);

        if (!options.forceApi && this.raw.available) {
            const outcome = await this.raw.fetchText(path);
            if (outcome.status === 'ok') return { text: outcome.value, source: 'raw' };
            if (outcome.status === 'missing') return null;
        }

        const result = await this.fetchRawContentViaApi(path);
        return result ? { text: result.text, source: 'api' } : null;
    }

    // ─── File Writes ──────────────────────────────────────────────────────

    /**
     * Create or update a file in the repo (single attempt, no retry).
     *
     * **Cost:** 1 REST call when the blob SHA is already cached (the common
     * case after a read or a previous write), otherwise 2.
     *
     * @param path - Path relative to the repository root
     * @param content - UTF-8 text content (JSON is stringified by the caller)
     * @param message - Commit message
     * @returns The new blob SHA
     * @throws {ValidationError} When the path is unsafe or the payload exceeds
     * GitHub's 1 MiB Contents API limit
     */
    async createOrUpdateFile(path: string, content: string, message: string): Promise<string> {
        const result = await this.writeOnce(path, content, message, false);
        return result.blobSha;
    }

    /**
     * Create or update a file, retrying with exponential backoff on 409 Conflict.
     *
     * A 409 means another writer committed to the same path first; the cached
     * blob SHA is invalidated so the retry reads the current one.
     *
     * **Cost:** 1–2 REST calls per attempt.
     *
     * @param path - Path relative to the repository root
     * @param content - UTF-8 text content
     * @param message - Commit message
     * @returns The new blob SHA
     * @throws {ConflictError} When every retry attempt hit a 409
     */
    async createOrUpdateFileWithRetry(
        path: string,
        content: string,
        message: string,
    ): Promise<string> {
        const result = await this.writeFile(path, content, message);
        return result.blobSha;
    }

    /**
     * Create or update a file with retry, returning the full write metadata.
     *
     * The commit SHA and its parents let the caller advance a sync cursor
     * without an extra `listCommits` request, and detect that another device
     * committed in between.
     *
     * @param path - Path relative to the repository root
     * @param content - UTF-8 text content
     * @param message - Commit message
     * @returns Blob SHA, commit SHA and parent commit SHAs
     * @throws {ConflictError} When every retry attempt hit a 409
     */
    async writeFile(path: string, content: string, message: string): Promise<WriteResult> {
        assertValidRepoPath(path);

        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.writeOnce(path, content, message, attempt > 1);
            } catch (error: any) {
                if (error.status === 409 || error instanceof ConflictError) {
                    // Another writer won the race — drop the cached SHA so the
                    // next attempt fetches the current one.
                    this.shaCache.delete(path);
                    lastError = new ConflictError(path, attempt);
                    await delay(this.config.retryBaseDelay * attempt);
                    continue;
                }
                throw this.classifyError(error, `Failed to write ${path}`);
            }
        }

        throw lastError || new Error(`Unexpected retry failure while writing ${path}`);
    }

    /**
     * Delete a file from the repo. Silently succeeds when the file is absent.
     *
     * **Cost:** 1 REST call when the blob SHA is cached, otherwise 2.
     *
     * @param path - Path relative to the repository root
     * @param message - Commit message
     */
    async deleteFile(path: string, message: string): Promise<void> {
        this.ensureInitialized();
        assertValidRepoPath(path);
        this.assertRateLimitBudget();

        try {
            let sha = this.shaCache.get(path);

            if (!sha) {
                this.track();
                const { data } = await this.octokit!.repos.getContent({
                    owner: this.config.owner,
                    repo: this.config.repo,
                    path,
                    ref: this.config.branch,
                });
                if (!('sha' in data)) return;
                sha = data.sha;
            }

            this.track();
            await this.octokit!.repos.deleteFile({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                message,
                sha,
                branch: this.config.branch,
            });
            this.shaCache.delete(path);
        } catch (error: any) {
            if (error.status === 404) {
                this.shaCache.delete(path);
                return; // Already deleted
            }
            if (error.status === 409 && this.shaCache.has(path)) {
                // Cached SHA went stale — drop it and retry once.
                this.shaCache.delete(path);
                await this.deleteFile(path, message);
                return;
            }
            throw this.classifyError(error, `Failed to delete ${path}`);
        }
    }

    // ─── Compare Commits ─────────────────────────────────────────────────

    /**
     * Compare the sync cursor against the branch head to find changed files.
     *
     * This is the heart of incremental sync: only files listed here are
     * downloaded.
     *
     * **Cost:** 1 REST call.
     *
     * @param baseSha - Commit SHA of the local sync cursor
     * @returns Changed file paths plus the resolved head SHA. A 404 (unknown
     * base SHA, e.g. after a force-push or history rewrite) is reported as
     * `diverged` with no changed files, which makes the caller fall back to a
     * full pull.
     */
    async compareCommits(baseSha: string): Promise<CompareResult> {
        this.ensureInitialized();
        this.assertRateLimitBudget();

        try {
            this.track();
            const { data } = await this.octokit!.repos.compareCommits({
                owner: this.config.owner,
                repo: this.config.repo,
                base: baseSha,
                head: this.config.branch,
            });

            const changedFiles = (data.files || []).map((f) => f.filename);
            const commits = data.commits || [];
            const aheadBy = data.ahead_by ?? commits.length;

            // GitHub truncates a comparison at 250 commits / 300 files. Acting
            // on a truncated diff and then moving the cursor to the head would
            // permanently skip the changes that did not fit, so report it as
            // diverged — the caller responds with a full pull.
            if (aheadBy > COMPARE_COMMIT_LIMIT || changedFiles.length >= COMPARE_FILE_LIMIT) {
                return {
                    status: 'diverged',
                    changedFiles: [],
                    headSha: '',
                    aheadBy,
                    behindBy: data.behind_by ?? 0,
                };
            }

            // `commits` is ordered oldest → newest, so the last entry *is* the
            // head commit when the base is an ancestor. Using it avoids a
            // separate listCommits request per pull. An empty string means "head
            // unknown" and makes the caller resolve it explicitly.
            let headSha = '';
            if (data.status === 'identical') {
                headSha = baseSha;
            } else if (commits.length > 0) {
                headSha = commits[commits.length - 1].sha;
            }

            return {
                status: data.status,
                changedFiles,
                headSha,
                aheadBy,
                behindBy: data.behind_by ?? 0,
            };
        } catch (error: any) {
            if (error.status === 404) {
                // Base SHA not found (force-push, rewritten history) — need a full pull
                return {
                    status: 'diverged',
                    changedFiles: [],
                    headSha: '',
                    aheadBy: 0,
                    behindBy: 0,
                };
            }
            throw this.classifyError(error, 'Failed to compare commits');
        }
    }

    /**
     * Get the latest commit SHA for the branch.
     *
     * **Cost:** 1 REST call. Prefer the `commitSha` returned by
     * {@link writeFile} or {@link CompareResult.headSha} when one is available.
     */
    async getLatestCommitSha(): Promise<string> {
        this.ensureInitialized();
        this.assertRateLimitBudget();

        this.track();
        const { data: commits } = await this.octokit!.repos.listCommits({
            owner: this.config.owner,
            repo: this.config.repo,
            sha: this.config.branch,
            per_page: 1,
        });

        if (commits.length === 0) {
            throw new Error(`No commits found on branch ${this.config.branch}`);
        }

        return commits[0].sha;
    }

    // ─── Directory Listing ───────────────────────────────────────────────

    /**
     * List files in a directory within the repo (direct children only).
     *
     * **Cost:** 1 REST call. Returns filenames, not paths.
     *
     * @param path - Directory path relative to the repository root
     * @returns Filenames in the directory; empty when it does not exist
     */
    async listDirectory(path: string): Promise<string[]> {
        this.ensureInitialized();
        this.assertRateLimitBudget();

        try {
            this.track();
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });

            if (Array.isArray(data)) {
                return data.filter((f) => f.type === 'file').map((f) => f.name);
            }
            return [];
        } catch (error: any) {
            if (error.status === 404) return [];
            throw this.classifyError(error, `Failed to list ${path}`);
        }
    }

    /**
     * List every file below `path`, recursively.
     *
     * `listDirectory()` only returns direct children, so it misses files stored
     * in subfolders (e.g. `files/<taskId>/<name>.png`, the layout used by the
     * demo apps).
     *
     * **Cost:** 1 REST call (Git Trees API), regardless of depth.
     *
     * @param path - Directory path relative to the repository root
     * @returns Paths relative to `path`
     */
    async listDirectoryRecursive(path: string): Promise<string[]> {
        this.ensureInitialized();
        this.assertRateLimitBudget();

        try {
            this.track();
            const { data } = await this.octokit!.git.getTree({
                owner: this.config.owner,
                repo: this.config.repo,
                tree_sha: this.config.branch,
                recursive: 'true',
            });

            const prefix = path.endsWith('/') ? path : `${path}/`;

            return (data.tree ?? [])
                .filter(
                    (entry): entry is typeof entry & { path: string } =>
                        entry.type === 'blob' && !!entry.path && entry.path.startsWith(prefix),
                )
                .map((entry) => entry.path.slice(prefix.length));
        } catch (error: any) {
            if (error.status === 404) return [];
            throw this.classifyError(error, `Failed to list ${path} recursively`);
        }
    }

    // ─── Binary File Operations ─────────────────────────────────────────

    /**
     * Upload a binary file to the repo using base64 encoding.
     *
     * Uses files-first ordering — call this BEFORE updating collection
     * references so a failed metadata write can never leave a dangling pointer.
     *
     * **Cost:** 1 REST call when the blob SHA is cached, otherwise 2.
     *
     * @param path - Path within the repo, e.g. `files/task-1/photo.png`
     * @param base64Content - Base64-encoded bytes (no data-URL prefix)
     * @param message - Commit message
     * @returns The new blob SHA
     * @throws {ValidationError} When the decoded payload exceeds 1 MiB, the
     * hard limit of GitHub's Contents API
     */
    async uploadBinaryFile(path: string, base64Content: string, message: string): Promise<string> {
        this.ensureInitialized();
        assertValidRepoPath(path);
        assertBase64Size(path, base64Content);

        const result = await this.writeOnce(path, base64Content, message, false, true);
        return result.blobSha;
    }

    /**
     * Download a binary file.
     *
     * Served by `raw.githubusercontent.com` whenever possible — attachments are
     * usually the largest and most frequently read files in a repo, and raw
     * downloads do not consume rate limit.
     *
     * **Cost:** 0 REST calls when raw serves the read, otherwise 1.
     *
     * @param path - Path within the repo
     * @param options - Set `forceApi: true` to bypass the raw channel
     * @returns The file as a `Blob`
     */
    async downloadBinaryFile(path: string, options: FetchFileOptions = {}): Promise<Blob> {
        this.ensureInitialized();
        assertValidRepoPath(path);

        if (!options.forceApi && this.raw.available) {
            const outcome = await this.raw.fetchBlob(path);
            if (outcome.status === 'ok') return outcome.value;
            if (outcome.status === 'missing') {
                throw new ValidationError(path, 'File not found');
            }
            // 'unavailable' → fall through to the REST API.
        }

        this.assertRateLimitBudget();

        try {
            this.track();
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });

            if ('content' in data && typeof data.content === 'string') {
                const binaryStr = atob(data.content.replace(/\n/g, ''));
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                const encoding =
                    data.encoding === 'base64' ? 'application/octet-stream' : 'text/plain';
                this.shaCache.set(path, data.sha);
                return new Blob([bytes], { type: encoding });
            }

            throw new ValidationError(path, 'Download failed: unexpected response format');
        } catch (error: any) {
            if (error instanceof ValidationError) throw error;
            if (error.status === 404) throw new ValidationError(path, 'File not found');
            throw this.classifyError(error, `Failed to download ${path}`);
        }
    }

    // ─── Repo Metadata ──────────────────────────────────────────────────

    /**
     * Get the repository size in KB.
     *
     * **Cost:** 1 REST call.
     */
    async getRepoSize(): Promise<number> {
        this.ensureInitialized();
        this.assertRateLimitBudget();

        this.track();
        const { data } = await this.octokit!.repos.get({
            owner: this.config.owner,
            repo: this.config.repo,
        });

        this.cachedRepoSizeKb = data.size; // in KB
        return data.size;
    }

    /** Repo size learned during `init()`/`getRepoSize()` — costs nothing. */
    getCachedRepoSize(): number | null {
        return this.cachedRepoSizeKb;
    }

    /** Whether the repository is private (`null` before `init()`). */
    get repoIsPrivate(): boolean | null {
        return this.isPrivateRepo;
    }

    // ─── Rate Limit Tracking ────────────────────────────────────────────

    /** Last known rate limit remaining */
    rateLimitRemaining: number | null = null;

    /** Time when rate limit resets */
    rateLimitResetAt: Date | null = null;

    /**
     * Commit produced by the most recent successful write, or `null`.
     *
     * Lets the sync service advance its cursor without spending another request
     * on `listCommits`, and detect that another device committed in between.
     */
    getLastCommit(): { sha: string; parentShas: string[] } | null {
        return this.lastCommit;
    }

    /** Transport counters since construction (or the last {@link resetUsage}). */
    getUsage(): ApiUsage {
        const rawStats: RawContentStats = this.raw.getStats();
        return {
            apiCalls: this.apiCalls,
            rawReads: rawStats.hits,
            rawMisses: rawStats.misses,
            rawFallbacks: rawStats.fallbacks,
        };
    }

    /** Zero the transport counters — used to measure a single operation. */
    resetUsage(): void {
        this.apiCalls = 0;
        this.raw.resetStats();
    }

    /** Whether reads are currently being served from raw.githubusercontent.com. */
    get rawContentActive(): boolean {
        return this.config.useRawContent && this.raw.available;
    }

    /** Forget every cached blob SHA (e.g. after a history rewrite). */
    clearShaCache(): void {
        this.shaCache.clear();
    }

    // ─── Utility ─────────────────────────────────────────────────────────

    /**
     * Count a REST API call.
     *
     * Counted explicitly (rather than from an Octokit hook) so the budget
     * reporting stays accurate with any Octokit build or test double.
     */
    private track(): void {
        this.apiCalls += 1;
    }

    private ensureInitialized(): void {
        if (!this.octokit) {
            throw new Error('GitHubApiAdapter not initialized. Call init() first.');
        }
    }

    /**
     * Throw early when the REST rate limit is already exhausted — a much clearer
     * failure than GitHub's 403, and it avoids burning a request we know will fail.
     */
    private assertRateLimitBudget(): void {
        if (this.rateLimitRemaining === null || this.rateLimitRemaining > 0) return;
        const resetAt = this.rateLimitResetAt ?? new Date(Date.now() + 60_000);
        if (resetAt.getTime() <= Date.now()) return; // window already rolled over
        throw new RateLimitError(resetAt, this.rateLimitRemaining);
    }

    private warnIfRateLimitLow(): void {
        if (this.rateLimitRemaining === null || this.rateLimitRemaining >= 100) return;
        // Warn at most once per minute — a low budget is a state, not an event.
        const now = Date.now();
        if (now - this.lastRateLimitWarningAt < 60_000) return;
        this.lastRateLimitWarningAt = now;
        console.warn(
            `[GitterSync] Rate limit low: ${this.rateLimitRemaining} remaining. Resets at ${this.rateLimitResetAt?.toISOString()}`,
        );
    }

    /**
     * Translate an Octokit/HTTP error into the GitterSync error hierarchy.
     *
     * GitHub signals an exhausted rate limit with **403**, which would otherwise
     * be reported as an authentication failure.
     */
    private classifyError(error: any, contextMessage: string): Error {
        if (
            error instanceof ConflictError ||
            error instanceof RateLimitError ||
            error instanceof AuthError ||
            error instanceof ValidationError
        ) {
            return error;
        }

        const status: number | undefined = error?.status;
        const headers = (error?.response?.headers ?? {}) as Record<string, string | undefined>;

        const remaining = headers['x-ratelimit-remaining'];
        const reset = headers['x-ratelimit-reset'];
        const rateLimited =
            status === 429 ||
            (status === 403 && (remaining === '0' || /rate limit/i.test(error?.message ?? '')));

        if (rateLimited) {
            const resetAt = reset
                ? new Date(parseInt(reset, 10) * 1000)
                : new Date(Date.now() + 3_600_000);
            this.rateLimitRemaining = 0;
            this.rateLimitResetAt = resetAt;
            return new RateLimitError(resetAt, 0);
        }

        if (status === 401 || status === 403) {
            return new AuthError(status);
        }

        if (status === 409) {
            return error; // let the retry loop handle conflicts
        }

        return new Error(`${contextMessage}: ${error?.message ?? 'unknown error'}`, {
            cause: error,
        });
    }

    /**
     * Perform a single write, using the cached blob SHA when available.
     *
     * @param refreshSha - Force a fresh `getContent` lookup (used on retries)
     * @param rawBase64 - Content is already base64 (binary upload)
     */
    private async writeOnce(
        path: string,
        content: string,
        message: string,
        refreshSha: boolean,
        rawBase64 = false,
    ): Promise<WriteResult> {
        this.ensureInitialized();
        assertValidRepoPath(path);
        const encoded = rawBase64 ? content : utf8ToBase64(content);
        assertBase64Size(path, encoded);

        // Resolve the blob SHA of the current file, if any. A cached SHA saves a
        // whole REST call per write; a stale one produces a 409 that the retry
        // loop resolves by refreshing.
        let sha: string | undefined;
        if (!refreshSha && this.shaCache.has(path)) {
            sha = this.shaCache.get(path);
        } else {
            try {
                this.track();
                const { data } = await this.octokit!.repos.getContent({
                    owner: this.config.owner,
                    repo: this.config.repo,
                    path,
                    ref: this.config.branch,
                });
                if ('sha' in data) {
                    sha = data.sha;
                    this.shaCache.set(path, data.sha);
                }
            } catch (error: any) {
                if (error.status !== 404) throw error;
                // File doesn't exist — will create new
                this.shaCache.delete(path);
            }
        }

        this.assertRateLimitBudget();
        this.track();
        const { data: result } = await this.octokit!.repos.createOrUpdateFileContents({
            owner: this.config.owner,
            repo: this.config.repo,
            path,
            message,
            content: encoded,
            sha,
            branch: this.config.branch,
        });

        if (!result.content?.sha) {
            throw new Error(`Failed to create/update file ${path}: no SHA returned`);
        }

        this.shaCache.set(path, result.content.sha);

        const commit = result.commit as { sha?: string; parents?: { sha?: string }[] } | undefined;
        const parentShas = ((commit?.parents ?? []).map((parent) => parent?.sha).filter(Boolean) ??
            []) as string[];

        if (commit?.sha) {
            this.lastCommit = { sha: commit.sha, parentShas };
        }

        return {
            path,
            blobSha: result.content.sha,
            commitSha: commit?.sha ?? null,
            parentShas,
        };
    }

    /** Read a file's raw text through the REST API (used by fetchTextFile). */
    private async fetchRawContentViaApi(path: string): Promise<{ text: string } | null> {
        try {
            this.track();
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });
            if (!('content' in data)) {
                throw new ValidationError(path, 'Expected file content but got directory listing');
            }
            this.shaCache.set(path, data.sha);
            return { text: decodeBase64Utf8(data.content) };
        } catch (error: any) {
            if (error.status === 404) return null;
            throw this.classifyError(error, `Failed to read ${path}`);
        }
    }

    /** Get the configured owner */
    get owner(): string {
        return this.config.owner;
    }

    /** Get the configured repo */
    get repo(): string {
        return this.config.repo;
    }

    /** Get the configured branch */
    get branch(): string {
        return this.config.branch;
    }

    /** Get the compaction threshold */
    get compactionThreshold(): number {
        return this.config.compactionThreshold;
    }

    /** Get the soft-delete retention window used by compaction */
    get deleteRetentionMs(): number {
        return this.config.deleteRetentionMs;
    }
}

// ─── Module Helpers ────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Encode a UTF-8 string as base64.
 *
 * `btoa` only accepts Latin-1, so non-ASCII text is percent-escaped first.
 * `Buffer` is used when available (Node) because it handles large payloads
 * without the intermediate string churn.
 */
export function utf8ToBase64(text: string): string {
    const globalBuffer = (
        globalThis as { Buffer?: { from(s: string, e: string): { toString(enc: string): string } } }
    ).Buffer;
    if (globalBuffer) {
        return globalBuffer.from(text, 'utf-8').toString('base64');
    }
    if (typeof btoa !== 'function') {
        throw new Error('Neither btoa nor Buffer is available to encode content');
    }
    return btoa(unescape(encodeURIComponent(text)));
}

/** Decode base64 into a UTF-8 string (GitHub returns newline-wrapped base64). */
export function decodeBase64Utf8(base64: string): string {
    const clean = base64.replace(/\n/g, '');
    const globalBuffer = (
        globalThis as { Buffer?: { from(s: string, e: string): { toString(enc: string): string } } }
    ).Buffer;
    if (globalBuffer) {
        return globalBuffer.from(clean, 'base64').toString('utf-8');
    }
    return decodeURIComponent(escape(atob(clean)));
}

/**
 * Guard against GitHub's Contents API size limit (1 MiB decoded).
 *
 * @throws {ValidationError} When the payload is too large
 */
function assertBase64Size(path: string, base64Content: string): void {
    if (typeof base64Content !== 'string') {
        throw new ValidationError(path, 'Content must be a base64-encoded string');
    }
    const approxBytes = Math.floor((base64Content.length * 3) / 4);
    if (approxBytes > MAX_CONTENT_API_BYTES) {
        throw new ValidationError(
            path,
            `File is ${(approxBytes / 1024 / 1024).toFixed(2)} MiB — GitHub's Contents API accepts at most 1 MiB per file`,
        );
    }
}
