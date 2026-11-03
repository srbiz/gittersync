/**
 * GitterSync — Raw Content Client
 *
 * Reads repository files from `raw.githubusercontent.com` instead of the GitHub
 * REST API.
 *
 * **Why this matters.** The REST API is rate limited per hour (5,000 requests
 * for authenticated users, 60 for anonymous ones) and *every* response counts,
 * including the `GET /repos/{owner}/{repo}/contents/{path}` calls that make up
 * the bulk of a pull. `raw.githubusercontent.com` is a separate CDN front door
 * that is not part of the REST rate limit budget, so a full pull of a
 * repository with 20 collections costs 20 REST calls with the API and ~2 with
 * raw reads (the Compare call plus the commit lookup).
 *
 * **Trade-offs handled here.**
 * - Raw responses are CDN cached (≈5 minutes). A cache-busting query parameter
 *   is appended by default so sync reads are never served stale content.
 * - Raw responses carry no blob SHA. Callers that need one must use the API.
 * - GitHub answers `404` for private repositories when the caller is not
 *   authorised, so a `404` is only trustworthy once the visibility of the
 *   repository is known. {@link RawContentClient.setRepoVisibility} records it
 *   (the adapter learns it from the `repos.get` call made during `init()`);
 *   without it the client probes the authenticated channel once and otherwise
 *   reports `unavailable` so the caller can fall back to the REST API.
 * - Private repositories need an `Authorization` header, which triggers a CORS
 *   preflight in browsers. If that preflight is blocked the client permanently
 *   degrades to the REST API instead of failing.
 *
 * Every failure mode degrades to "ask the caller to use the REST API" — raw
 * reads are an optimisation, never a correctness requirement.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** Outcome of a raw content request. */
export type RawFetchOutcome<T> =
    /** Request succeeded; `value` holds the decoded payload. */
    | { status: 'ok'; value: T }
    /** The file definitively does not exist on the configured ref. */
    | { status: 'missing' }
    /**
     * Raw content could not be used (network/CORS error, auth problem, invalid
     * payload, or an ambiguous 404). The caller should fall back to the REST
     * API.
     */
    | { status: 'unavailable'; reason: string };

/** Configuration for {@link RawContentClient}. */
export interface RawContentConfig {
    /** Repository owner */
    owner: string;
    /** Repository name */
    repo: string;
    /** Branch, tag or commit SHA to read from */
    ref: string;
    /** Token used for private repositories — omitted from anonymous requests */
    token?: string | null;
    /** Raw host — defaults to `https://raw.githubusercontent.com` */
    baseUrl?: string;
    /** Append a cache-busting query parameter — defaults to `true` */
    cacheBust?: boolean;
    /** Per-request timeout in ms — defaults to `30000` */
    timeoutMs?: number;
}

/** Counters exposed for status panels, tests and documentation. */
export interface RawContentStats {
    /** Reads served by raw.githubusercontent.com (rate-limit free) */
    hits: number;
    /** Reads where raw reliably reported "file does not exist" */
    misses: number;
    /** Reads that had to fall back to the REST API */
    fallbacks: number;
    /** Approximate bytes downloaded through the raw channel */
    bytes: number;
}

type AuthMode = 'anonymous' | 'authenticated';

// ─── Client ────────────────────────────────────────────────────────────────

/**
 * Fetches repository content over the raw CDN endpoint.
 *
 * @example
 * ```typescript
 * const raw = new RawContentClient({ owner: 'me', repo: 'data', ref: 'main', token })
 * const result = await raw.fetchJson('collections/users.json')
 * if (result.status === 'ok') console.log(result.value)
 * else if (result.status === 'missing') console.log('no such file')
 * else console.log('use the REST API instead:', result.reason)
 * ```
 */
export class RawContentClient {
    private readonly owner: string;
    private readonly repo: string;
    private readonly ref: string;
    private readonly baseUrl: string;
    private readonly cacheBust: boolean;
    private readonly timeoutMs: number;
    private token: string | null;

    private mode: AuthMode = 'anonymous';
    /**
     * `null` while unknown, `true` once an authenticated request succeeded,
     * `false` once it failed (CORS preflight blocked, 401/403, …).
     */
    private authWorks: boolean | null = null;
    /** Set when raw content is unusable in this environment (e.g. CORS block) */
    private disabledReason: string | null = null;
    /**
     * True when a `404` can be trusted as "file does not exist". Set by
     * {@link setRepoVisibility} or after the first successful read.
     */
    private trust404 = false;
    /** Repository visibility learned from the REST API (`null` when unknown) */
    private repoPrivate: boolean | null = null;

    private readonly stats: RawContentStats = { hits: 0, misses: 0, fallbacks: 0, bytes: 0 };

    constructor(config: RawContentConfig) {
        this.owner = config.owner;
        this.repo = config.repo;
        this.ref = config.ref;
        this.token = config.token ?? null;
        this.baseUrl = (config.baseUrl ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
        this.cacheBust = config.cacheBust ?? true;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }

    // ─── Public API ──────────────────────────────────────────────────────

    /** Whether raw reads are configured *and* still usable in this environment. */
    get available(): boolean {
        return this.disabledReason === null && typeof fetch === 'function';
    }

    /** Reason raw content was disabled, or `null` when it is still usable. */
    get disabledReasonValue(): string | null {
        return this.disabledReason;
    }

    /** Whether raw requests currently carry an `Authorization` header. */
    get usesAuthentication(): boolean {
        return this.mode === 'authenticated';
    }

    /** A snapshot of the raw/API split counters. */
    getStats(): RawContentStats {
        return { ...this.stats };
    }

    /** Number of REST API calls avoided so far. */
    get requestsSaved(): number {
        return this.stats.hits + this.stats.misses;
    }

    /** Permanently stop using raw content (e.g. after a CORS failure). */
    disable(reason: string): void {
        this.disabledReason = reason;
    }

    /** Update the token — used when a service is re-initialised with a new PAT. */
    setToken(token: string | null): void {
        this.token = token;
        // A new token may unlock the authenticated channel — allow one more probe.
        this.authWorks = null;
        if (!token) {
            this.mode = 'anonymous';
            if (this.repoPrivate === true) this.trust404 = false;
        } else if (this.repoPrivate === true) {
            this.mode = 'authenticated';
            this.trust404 = true;
        }
    }

    /**
     * Record the repository visibility learned from the REST API.
     *
     * - **public** → read anonymously; `404` reliably means "missing".
     * - **private** → send the token; `404` reliably means "missing" because
     *   `init()` already proved the token can read this repository.
     *
     * @param isPrivate - `true` when the repository is private
     */
    setRepoVisibility(isPrivate: boolean): void {
        this.repoPrivate = isPrivate;
        this.mode = isPrivate && this.token ? 'authenticated' : 'anonymous';
        // A public repo can be read anonymously, and a private repo can be read
        // with the token that init() already validated — in both cases a 404
        // really means "missing".
        this.trust404 = !isPrivate || !!this.token;
    }

    /** Zero the transport counters — used to measure a single operation. */
    resetStats(): void {
        this.stats.hits = 0;
        this.stats.misses = 0;
        this.stats.fallbacks = 0;
        this.stats.bytes = 0;
    }

    /**
     * Build the raw URL for a repository path.
     *
     * @param path - Path relative to the repository root
     * @param bust - Override the cache-busting behaviour for this URL
     */
    urlFor(path: string, bust = this.cacheBust): string {
        const encoded = path
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/');
        const base = `${this.baseUrl}/${this.owner}/${this.repo}/${this.ref}/${encoded}`;
        if (!bust) return base;
        // Unique query string ⇒ unique CDN cache key ⇒ no stale reads.
        return `${base}?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Fetch a file as text.
     *
     * @param path - Path relative to the repository root
     */
    async fetchText(path: string): Promise<RawFetchOutcome<string>> {
        return this.request(path, async (response) => {
            const text = await response.text();
            this.stats.bytes += text.length;
            return text;
        });
    }

    /**
     * Fetch a file and parse it as JSON.
     *
     * Malformed JSON is reported as `unavailable` (not `ok`) so the caller can
     * retry through the REST API — a truncated CDN response must never be
     * mistaken for authoritative data.
     *
     * @param path - Path relative to the repository root
     */
    async fetchJson<T = unknown>(path: string): Promise<RawFetchOutcome<T>> {
        const textResult = await this.fetchText(path);
        if (textResult.status !== 'ok') return textResult;

        try {
            return { status: 'ok', value: JSON.parse(textResult.value) as T };
        } catch (error) {
            if (this.stats.hits > 0) this.stats.hits -= 1;
            return this.fallback(
                `raw response for ${path} is not valid JSON: ${(error as Error).message}`,
            );
        }
    }

    /**
     * Fetch a file as a `Blob` — used for binary attachments.
     *
     * @param path - Path relative to the repository root
     */
    async fetchBlob(path: string): Promise<RawFetchOutcome<Blob>> {
        return this.request(path, async (response) => {
            const blob = await response.blob();
            this.stats.bytes += blob.size;
            return blob;
        });
    }

    // ─── Internals ───────────────────────────────────────────────────────

    private async request<T>(
        path: string,
        decode: (response: Response) => Promise<T>,
    ): Promise<RawFetchOutcome<T>> {
        if (!this.available) {
            return this.fallback(
                this.disabledReason ?? 'fetch is not available in this environment',
            );
        }
        return this.attempt(path, decode, this.mode, true);
    }

    private async attempt<T>(
        path: string,
        decode: (response: Response) => Promise<T>,
        mode: AuthMode,
        allowProbe: boolean,
    ): Promise<RawFetchOutcome<T>> {
        let response: Response;
        try {
            response = await this.doFetch(path, mode);
        } catch (error) {
            // Network error: offline, DNS, or a blocked CORS preflight. The
            // preflight only happens when an Authorization header is sent, so
            // retry anonymously before giving up on raw content entirely.
            const reason = `raw request for ${path} failed: ${(error as Error).message}`;
            if (mode === 'authenticated' && this.authWorks === null) {
                this.authWorks = false;
                if (this.repoPrivate === true) {
                    // Anonymous reads of a private repo return 404 for
                    // *everything*, which would silently look like empty
                    // collections. Stop using raw content altogether.
                    this.mode = 'anonymous';
                    this.trust404 = false;
                    this.disable(
                        'raw content needs an authenticated request that this environment blocks (CORS preflight)',
                    );
                    return this.fallback(reason);
                }
                this.mode = 'anonymous';
                return this.attempt(path, decode, 'anonymous', false);
            }
            if (mode === 'anonymous') {
                this.disable(`raw content is unreachable (${reason})`);
            }
            return this.fallback(reason);
        }

        if (response.ok) {
            this.trust404 = true;
            if (mode === 'authenticated') {
                this.authWorks = true;
                this.mode = 'authenticated';
            }
            try {
                const value = await decode(response);
                this.stats.hits += 1;
                return { status: 'ok', value };
            } catch (error) {
                return this.fallback(
                    `could not decode raw response for ${path}: ${(error as Error).message}`,
                );
            }
        }

        if (response.status === 404) {
            return this.handleNotFound(path, decode, mode, allowProbe);
        }

        if (response.status === 401 || response.status === 403) {
            const reason = `raw content rejected the request (HTTP ${response.status})`;
            if (mode === 'authenticated') {
                // Token rejected by the CDN — the REST API handles auth properly.
                this.authWorks = false;
                this.mode = 'anonymous';
                this.trust404 = this.repoPrivate === true ? false : this.trust404;
                return this.fallback(reason);
            }
            this.disable(reason);
            return this.fallback(reason);
        }

        return this.fallback(`raw content returned HTTP ${response.status} for ${path}`);
    }

    private async handleNotFound<T>(
        path: string,
        decode: (response: Response) => Promise<T>,
        mode: AuthMode,
        allowProbe: boolean,
    ): Promise<RawFetchOutcome<T>> {
        // GitHub hides private repositories behind a 404, so an anonymous 404
        // is ambiguous until we know the visibility. Probe the authenticated
        // channel once to find out.
        if (
            mode === 'anonymous' &&
            !this.trust404 &&
            this.token &&
            this.authWorks === null &&
            allowProbe
        ) {
            return this.attempt(path, decode, 'authenticated', false);
        }

        if (mode === 'anonymous' && this.repoPrivate === true) {
            // Anonymous 404 on a private repo means "not authorised".
            return this.fallback(`raw returned 404 for ${path} on a private repository`);
        }

        if (this.trust404 || this.authWorks === true) {
            this.stats.misses += 1;
            return { status: 'missing' };
        }

        // Still ambiguous — let the REST API decide whether the file exists.
        return this.fallback(`raw returned 404 for ${path} and repository visibility is unknown`);
    }

    private async doFetch(path: string, mode: AuthMode): Promise<Response> {
        const headers: Record<string, string> = {};
        if (mode === 'authenticated' && this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer =
            controller && this.timeoutMs > 0
                ? setTimeout(() => controller.abort(), this.timeoutMs)
                : null;

        try {
            // No cookies/credentials: raw content is either public or
            // token-authenticated, and omitting them avoids a CORS preflight
            // for anonymous reads.
            return await fetch(this.urlFor(path), {
                method: 'GET',
                headers,
                signal: controller?.signal ?? undefined,
                cache: 'no-store',
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private fallback<T>(reason: string): RawFetchOutcome<T> {
        this.stats.fallbacks += 1;
        return { status: 'unavailable', reason };
    }
}
