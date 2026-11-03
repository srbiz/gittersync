/**
 * GitterSync — API Adapter: raw reads, SHA caching and error mapping
 *
 * Octokit is mocked and `globalThis.fetch` is stubbed, so this suite proves the
 * request-budget behaviour without touching the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubApiAdapter } from '../src/github-api';
import { RateLimitError, AuthError, ValidationError, ConflictError } from '../src/types';
import type { GitHubSyncConfig } from '../src/types';

// ─── Mock Octokit ───────────────────────────────────────────────────────────

const mockReposGet = vi.fn();
const mockReposGetContent = vi.fn();
const mockReposCreateOrUpdateFileContents = vi.fn();
const mockReposDeleteFile = vi.fn();
const mockReposCompareCommits = vi.fn();
const mockReposListCommits = vi.fn();
const mockGitGetTree = vi.fn();
const hookAfter = vi.fn();

vi.mock('@octokit/rest', () => ({
    Octokit: vi.fn().mockImplementation(() => ({
        hook: { after: hookAfter },
        repos: {
            get: mockReposGet,
            getContent: mockReposGetContent,
            createOrUpdateFileContents: mockReposCreateOrUpdateFileContents,
            deleteFile: mockReposDeleteFile,
            compareCommits: mockReposCompareCommits,
            listCommits: mockReposListCommits,
        },
        git: { getTree: mockGitGetTree },
    })),
}));

// ─── Fetch stub ────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

function rawJson(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: async () => init.text ?? JSON.stringify(body),
        blob: async () => new Blob([init.text ?? JSON.stringify(body)]),
    };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function createAdapter(overrides: Partial<GitHubSyncConfig> = {}): GitHubApiAdapter {
    return new GitHubApiAdapter({
        owner: 'testuser',
        repo: 'test-repo',
        branch: 'main',
        retryBaseDelay: 1,
        ...overrides,
    });
}

function encodeContent(obj: unknown): string {
    return btoa(JSON.stringify(obj));
}

function fileResponse(content: string, sha = 'file-sha') {
    return {
        data: {
            type: 'file',
            content,
            sha,
            encoding: 'base64',
            name: 'x.json',
            path: 'x.json',
        },
        status: 200,
    };
}

async function initAdapter(
    overrides: Partial<GitHubSyncConfig> = {},
    repoData: Record<string, unknown> = { size: 1000, private: false },
): Promise<GitHubApiAdapter> {
    mockReposGet.mockResolvedValue({ data: repoData });
    const adapter = createAdapter(overrides);
    await adapter.init('ghp_token');
    return adapter;
}

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ─── Raw reads ─────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — raw content reads', () => {
    it('serves a JSON read from raw content without a REST call', async () => {
        const adapter = await initAdapter();
        fetchMock.mockResolvedValue(rawJson({ collection: 'users', version: 7 }));

        const result = await adapter.fetchJsonFile('collections/users.json');

        expect(result).not.toBeNull();
        expect(result!.source).toBe('raw');
        expect(result!.content).toEqual({ collection: 'users', version: 7 });
        expect(mockReposGetContent).not.toHaveBeenCalled();
        expect(adapter.getUsage().rawReads).toBe(1);
    });

    it('builds the raw URL from owner, repo, branch and path', async () => {
        const adapter = await initAdapter({ branch: 'data' });
        fetchMock.mockResolvedValue(rawJson({}));

        await adapter.fetchJsonFile('meta.json');

        const url = fetchMock.mock.calls[0][0] as string;
        expect(
            url.startsWith('https://raw.githubusercontent.com/testuser/test-repo/data/meta.json'),
        ).toBe(true);
    });

    it('falls back to the REST API when raw content is unavailable', async () => {
        const adapter = await initAdapter();
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        mockReposGetContent.mockResolvedValue(
            fileResponse(encodeContent({ collection: 'users' }), 'api-sha'),
        );

        const result = await adapter.fetchJsonFile('collections/users.json');

        expect(result!.source).toBe('api');
        expect(result!.sha).toBe('api-sha');
        expect(mockReposGetContent).toHaveBeenCalledTimes(1);
        expect(adapter.getUsage().apiCalls).toBe(2); // repos.get during init + the fallback read
        expect(adapter.getUsage().rawFallbacks).toBe(1);
    });

    it('treats a raw 404 on a public repo as a missing file', async () => {
        const adapter = await initAdapter();
        fetchMock.mockResolvedValue(rawJson(null, { ok: false, status: 404 }));

        const result = await adapter.fetchJsonFile('collections/absent.json');

        expect(result).toBeNull();
        expect(mockReposGetContent).not.toHaveBeenCalled();
        expect(adapter.getUsage().rawMisses).toBe(1);
    });

    it('skips raw content entirely when useRawContent is false', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent({ ok: true })));

        const result = await adapter.fetchJsonFile('meta.json');

        expect(result!.source).toBe('api');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(adapter.rawContentActive).toBe(false);
    });

    it('honours forceApi for write-critical reads', async () => {
        const adapter = await initAdapter();
        fetchMock.mockResolvedValue(rawJson({ collection: 'users' }));
        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent({ collection: 'users' })));

        const result = await adapter.fetchJsonFile('collections/users.json', { forceApi: true });

        expect(result!.source).toBe('api');
        expect(result!.sha).toBe('file-sha');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('serves binary downloads from raw content', async () => {
        const adapter = await initAdapter();
        const blob = new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' });
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            blob: async () => blob,
            text: async () => '',
        });

        const result = await adapter.downloadBinaryFile('files/photo.png');

        expect(result).toBe(blob);
        expect(mockReposGetContent).not.toHaveBeenCalled();
    });

    it('falls back to the REST API for binary downloads when raw fails', async () => {
        const adapter = await initAdapter();
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent('payload')));

        const result = await adapter.downloadBinaryFile('files/photo.png');

        expect(result).toBeInstanceOf(Blob);
        expect(mockReposGetContent).toHaveBeenCalledTimes(1);
    });

    it('reports raw content as active only while it is usable', async () => {
        const adapter = await initAdapter();
        expect(adapter.rawContentActive).toBe(true);

        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        await adapter.fetchJsonFile('meta.json');

        expect(adapter.rawContentActive).toBe(false);
    });
});

// ─── SHA cache ─────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — blob SHA cache', () => {
    it('reuses the SHA learned from a read instead of re-fetching it', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent({ v: 1 }), 'known-sha'));
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'new-sha' }, commit: { sha: 'commit-1', parents: [] } },
        });

        await adapter.fetchJsonFile('collections/users.json');
        mockReposGetContent.mockClear();

        await adapter.createOrUpdateFile('collections/users.json', '{"v":2}', 'Update');

        // No extra getContent: the cached SHA is sent with the write
        expect(mockReposGetContent).not.toHaveBeenCalled();
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
            expect.objectContaining({ sha: 'known-sha' }),
        );
    });

    it('reuses the SHA returned by a previous write', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        const notFound = Object.assign(new Error('Not Found'), { status: 404 });
        mockReposGetContent.mockRejectedValue(notFound);
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'sha-1' }, commit: { sha: 'c1', parents: [] } },
        });

        await adapter.createOrUpdateFile('meta.json', '{}', 'first');
        mockReposGetContent.mockClear();
        await adapter.createOrUpdateFile('meta.json', '{}', 'second');

        expect(mockReposGetContent).not.toHaveBeenCalled();
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenLastCalledWith(
            expect.objectContaining({ sha: 'sha-1' }),
        );
    });

    it('refreshes the SHA and retries after a 409 conflict', async () => {
        const adapter = await initAdapter({ useRawContent: false, maxRetries: 2 });
        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent({}), 'fresh-sha'));
        const conflict = Object.assign(new Error('Conflict'), { status: 409 });
        mockReposCreateOrUpdateFileContents.mockRejectedValueOnce(conflict).mockResolvedValueOnce({
            data: { content: { sha: 'final-sha' }, commit: { sha: 'c2', parents: [] } },
        });

        // Seed the cache with a stale SHA
        (adapter as unknown as { shaCache: Map<string, string> }).shaCache.set(
            'meta.json',
            'stale-sha',
        );

        const sha = await adapter.createOrUpdateFileWithRetry('meta.json', '{}', 'Update');

        expect(sha).toBe('final-sha');
        expect(mockReposGetContent).toHaveBeenCalled();
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenLastCalledWith(
            expect.objectContaining({ sha: 'fresh-sha' }),
        );
    });

    it('exposes the commit produced by the last write', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        mockReposGetContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: {
                content: { sha: 'blob-sha' },
                commit: { sha: 'commit-sha', parents: [{ sha: 'parent-sha' }] },
            },
        });

        expect(adapter.getLastCommit()).toBeNull();
        const result = await adapter.writeFile('meta.json', '{}', 'msg');

        expect(result).toEqual({
            path: 'meta.json',
            blobSha: 'blob-sha',
            commitSha: 'commit-sha',
            parentShas: ['parent-sha'],
        });
        expect(adapter.getLastCommit()).toEqual({ sha: 'commit-sha', parentShas: ['parent-sha'] });
    });
});

// ─── Validation ────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — input validation', () => {
    it('rejects an empty token', async () => {
        const adapter = createAdapter();
        await expect(adapter.init('')).rejects.toThrow(ValidationError);
    });

    it('rejects unsafe repository paths', async () => {
        const adapter = await initAdapter();

        await expect(adapter.fetchJsonFile('../secrets.json')).rejects.toThrow(ValidationError);
        await expect(adapter.fetchJsonFile('/etc/passwd')).rejects.toThrow(ValidationError);
        await expect(adapter.createOrUpdateFile('a//b.json', '{}', 'x')).rejects.toThrow(
            ValidationError,
        );
    });

    it('rejects uploads larger than the 1 MiB Contents API limit', async () => {
        const adapter = await initAdapter();
        const tooBig = 'A'.repeat(1024 * 1024 * 2);

        await expect(adapter.uploadBinaryFile('files/big.bin', tooBig, 'msg')).rejects.toThrow(
            ValidationError,
        );
        await expect(adapter.uploadBinaryFile('files/big.bin', tooBig, 'msg')).rejects.toThrow(
            /1 MiB/,
        );
    });

    it('throws when used before init', async () => {
        const adapter = createAdapter();
        await expect(adapter.fetchJsonFile('meta.json')).rejects.toThrow('not initialized');
    });
});

// ─── Error mapping ─────────────────────────────────────────────────────────

describe('GitHubApiAdapter — error mapping', () => {
    it('maps a 403 with an exhausted rate limit to RateLimitError', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        const error = Object.assign(new Error('API rate limit exceeded for user'), {
            status: 403,
            response: {
                headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' },
            },
        });
        mockReposGetContent.mockRejectedValue(error);

        await expect(adapter.fetchJsonFile('meta.json')).rejects.toThrow(RateLimitError);
        expect(adapter.rateLimitRemaining).toBe(0);
    });

    it('maps a plain 403 to AuthError', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        mockReposGetContent.mockRejectedValue(
            Object.assign(new Error('Forbidden'), { status: 403 }),
        );

        await expect(adapter.fetchJsonFile('meta.json')).rejects.toThrow(AuthError);
    });

    it('throws RateLimitError before spending a request when the budget is gone', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        adapter.rateLimitRemaining = 0;
        adapter.rateLimitResetAt = new Date(Date.now() + 60_000);

        await expect(adapter.fetchJsonFile('meta.json')).rejects.toThrow(RateLimitError);
        expect(mockReposGetContent).not.toHaveBeenCalled();
    });

    it('surfaces ConflictError after exhausting retries', async () => {
        const adapter = await initAdapter({ useRawContent: false, maxRetries: 2 });
        mockReposGetContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
        mockReposCreateOrUpdateFileContents.mockRejectedValue(
            Object.assign(new Error('Conflict'), { status: 409 }),
        );

        await expect(adapter.createOrUpdateFileWithRetry('meta.json', '{}', 'msg')).rejects.toThrow(
            ConflictError,
        );
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledTimes(2);
    });

    it('records repo visibility and size from init', async () => {
        const adapter = await initAdapter({}, { size: 4242, private: true });

        expect(adapter.repoIsPrivate).toBe(true);
        expect(adapter.getCachedRepoSize()).toBe(4242);
    });
});

// ─── Usage counters ────────────────────────────────────────────────────────

describe('GitHubApiAdapter — usage counters', () => {
    it('counts REST calls and can be reset', async () => {
        const adapter = await initAdapter({ useRawContent: false });
        expect(adapter.getUsage().apiCalls).toBe(1); // repos.get during init

        mockReposGetContent.mockResolvedValue(fileResponse(encodeContent({})));
        await adapter.fetchJsonFile('meta.json');
        expect(adapter.getUsage().apiCalls).toBe(2);

        adapter.resetUsage();
        expect(adapter.getUsage().apiCalls).toBe(0);
    });

    it('warns about a low rate limit at most once per minute', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const adapter = await initAdapter({ useRawContent: false });

        const response = {
            headers: { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '4102444800' },
        };
        const handler = hookAfter.mock.calls[0][1] as (r: unknown) => Promise<void>;

        await handler(response);
        await handler(response);
        await handler(response);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(adapter.rateLimitRemaining).toBe(12);
        warn.mockRestore();
    });
});
