/**
 * GitterSync — GitHub API Adapter
 *
 * Low-level wrapper around GitHub's Content API and Compare API.
 * Handles base64 encoding, SHA tracking, and rate limit monitoring.
 */

import { Octokit } from '@octokit/rest';
import type { GitHubSyncConfig, MetaFile, ChangelogFile, CollectionFile } from './types';
import { ConflictError, RateLimitError, AuthError, ValidationError } from './types';

/**
 * Result of a file read from GitHub.
 */
interface GitHubFileResult {
    /** Decoded JSON content */
    content: unknown;
    /** Git blob SHA of the file */
    sha: string;
}

/**
 * Result of a compare commits operation.
 */
interface CompareResult {
    /** 'identical' | 'ahead' | 'behind' | 'diverged' */
    status: string;
    /** List of changed file paths */
    changedFiles: string[];
    /** Latest commit SHA */
    headSha: string;
}

/**
 * GitHub API adapter — wraps Octokit calls with GitterSync-specific logic.
 */
export class GitHubApiAdapter {
    private octokit: Octokit | null = null;
    private readonly config: Required<GitHubSyncConfig>;

    constructor(config: GitHubSyncConfig) {
        this.config = {
            owner: config.owner,
            repo: config.repo,
            branch: config.branch ?? 'main',
            compactionThreshold: config.compactionThreshold ?? 20,
            maxRetries: config.maxRetries ?? 3,
            retryBaseDelay: config.retryBaseDelay ?? 1000,
            onSyncStatusChange: config.onSyncStatusChange ?? (() => {}),
        };
    }

    // ─── Initialization ───────────────────────────────────────────────────

    /**
     * Initialize the adapter with a GitHub token.
     * Verifies repo access by fetching the repo metadata.
     */
    async init(token: string): Promise<boolean> {
        this.octokit = new Octokit({ auth: token });

        this.octokit.hook.after('request', async (response) => {
            const headers = response.headers as Record<string, string>;
            const remaining = headers['x-ratelimit-remaining'];
            const resetAt = headers['x-ratelimit-reset'];
            if (remaining) this.rateLimitRemaining = parseInt(remaining, 10);
            if (resetAt) this.rateLimitResetAt = new Date(parseInt(resetAt, 10) * 1000);
            if (this.rateLimitRemaining !== null && this.rateLimitRemaining < 100) {
                console.warn(
                    `[GitterSync] Rate limit low: ${this.rateLimitRemaining} remaining. Resets at ${this.rateLimitResetAt?.toISOString()}`,
                );
            }
        });

        try {
            await this.octokit.repos.get({
                owner: this.config.owner,
                repo: this.config.repo,
            });
            return true;
        } catch (error: any) {
            if (error.status === 401 || error.status === 403) {
                throw new AuthError(error.status);
            }
            throw new Error(
                `Failed to access repo ${this.config.owner}/${this.config.repo}: ${error.message}`,
                { cause: error },
            );
        }
    }

    // ─── File Operations ─────────────────────────────────────────────────

    /**
     * Fetch and decode a JSON file from the repo.
     * Returns null if the file doesn't exist (404).
     */
    async fetchJsonFile<T = unknown>(path: string): Promise<GitHubFileResult | null> {
        this.ensureInitialized();

        try {
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
            return { content: decoded as T, sha: data.sha };
        } catch (error: any) {
            if (error.status === 404) return null;
            if (error.status === 401 || error.status === 403) {
                throw new AuthError(error.status);
            }
            throw error;
        }
    }

    /**
     * Create or update a JSON file in the repo.
     * If the file exists, it will be updated (requires SHA).
     * Returns the new blob SHA.
     */
    async createOrUpdateFile(path: string, content: string, message: string): Promise<string> {
        this.ensureInitialized();

        // Get current SHA if file exists
        let sha: string | undefined;
        try {
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });
            if ('sha' in data) sha = data.sha;
        } catch (error: any) {
            if (error.status !== 404) throw error;
            // File doesn't exist — will create new
        }

        // Encode to base64
        const encoded = btoa(unescape(encodeURIComponent(content)));

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
        return result.content.sha;
    }

    /**
     * Create or update a file with retry on 409 Conflict.
     */
    async createOrUpdateFileWithRetry(
        path: string,
        content: string,
        message: string,
    ): Promise<string> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.createOrUpdateFile(path, content, message);
            } catch (error: any) {
                if (error.status === 409) {
                    lastError = new ConflictError(path, attempt);
                    // Exponential backoff
                    const delay = this.config.retryBaseDelay * attempt;
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                throw error;
            }
        }

        throw lastError || new Error('Unexpected retry failure');
    }

    /**
     * Delete a file from the repo.
     */
    async deleteFile(path: string, message: string): Promise<void> {
        this.ensureInitialized();

        try {
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });

            if ('sha' in data) {
                await this.octokit!.repos.deleteFile({
                    owner: this.config.owner,
                    repo: this.config.repo,
                    path,
                    message,
                    sha: data.sha,
                    branch: this.config.branch,
                });
            }
        } catch (error: any) {
            if (error.status === 404) return; // Already deleted
            throw error;
        }
    }

    // ─── Compare Commits ─────────────────────────────────────────────────

    /**
     * Compare two commits to find changed files.
     * Used for incremental sync — only download what changed.
     */
    async compareCommits(baseSha: string): Promise<CompareResult> {
        this.ensureInitialized();

        try {
            const { data } = await this.octokit!.repos.compareCommits({
                owner: this.config.owner,
                repo: this.config.repo,
                base: baseSha,
                head: this.config.branch,
            });

            const changedFiles = (data.files || []).map((f) => f.filename);

            return {
                status: data.status,
                changedFiles,
                headSha: data.merge_base_commit?.sha || baseSha,
            };
        } catch (error: any) {
            if (error.status === 404) {
                // Base SHA not found — need a full pull
                return { status: 'diverged', changedFiles: [], headSha: baseSha };
            }
            throw error;
        }
    }

    /**
     * Get the latest commit SHA for the branch.
     */
    async getLatestCommitSha(): Promise<string> {
        this.ensureInitialized();

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
     * List files in a directory within the repo.
     * Returns filenames only (not paths).
     */
    async listDirectory(path: string): Promise<string[]> {
        this.ensureInitialized();

        try {
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
            throw error;
        }
    }

    // ─── Binary File Operations ─────────────────────────────────────────

    /**
     * Upload a binary file to the repo using base64 encoding.
     * Uses files-first ordering — call this BEFORE updating collection references.
     */
    async uploadBinaryFile(path: string, base64Content: string, message: string): Promise<string> {
        this.ensureInitialized();

        // Get current SHA if file exists
        let sha: string | undefined;
        try {
            const { data } = await this.octokit!.repos.getContent({
                owner: this.config.owner,
                repo: this.config.repo,
                path,
                ref: this.config.branch,
            });
            if ('sha' in data) sha = data.sha;
        } catch (error: any) {
            if (error.status !== 404) throw error;
        }

        const { data: result } = await this.octokit!.repos.createOrUpdateFileContents({
            owner: this.config.owner,
            repo: this.config.repo,
            path,
            message,
            content: base64Content,
            sha,
            branch: this.config.branch,
        });

        if (!result.content?.sha) {
            throw new Error(`Failed to upload binary file ${path}: no SHA returned`);
        }
        return result.content.sha;
    }

    /**
     * Download a binary file using the raw content URL.
     * Preferred over Content API for large files — avoids base64 string limits on mobile.
     */
    async downloadBinaryFile(path: string, token: string): Promise<Blob> {
        const url = `https://raw.githubusercontent.com/${this.config.owner}/${this.config.repo}/${this.config.branch}/${path}`;

        const response = await fetch(url, {
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/octet-stream',
            },
        });

        if (!response.ok) {
            throw new Error(`Download failed for ${path}: HTTP ${response.status}`);
        }

        return response.blob();
    }

    // ─── Repo Metadata ──────────────────────────────────────────────────

    /**
     * Get the repository size in KB.
     */
    async getRepoSize(): Promise<number> {
        this.ensureInitialized();

        const { data } = await this.octokit!.repos.get({
            owner: this.config.owner,
            repo: this.config.repo,
        });

        return data.size; // in KB
    }

    // ─── Rate Limit Tracking ────────────────────────────────────────────

    /** Last known rate limit remaining */
    rateLimitRemaining: number | null = null;

    /** Time when rate limit resets */
    rateLimitResetAt: Date | null = null;

    // ─── Utility ─────────────────────────────────────────────────────────

    private ensureInitialized(): void {
        if (!this.octokit) {
            throw new Error('GitHubApiAdapter not initialized. Call init() first.');
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
}
