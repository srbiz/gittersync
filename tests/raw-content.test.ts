/**
 * GitterSync — Raw Content Client Tests
 *
 * `globalThis.fetch` is stubbed, so no network access happens. These tests pin
 * the behaviour that makes raw reads a safe optimisation: cache busting, the
 * private-repo auth probe, and the "fall back to the REST API" outcomes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RawContentClient } from '../src/raw-content';

// ─── Fetch Stub ────────────────────────────────────────────────────────────

type StubResponse = {
    ok?: boolean;
    status?: number;
    text?: string;
    blob?: Blob;
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, init: StubResponse = {}) {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: async () => (typeof init.text === 'string' ? init.text : JSON.stringify(body)),
        blob: async () =>
            init.blob ??
            new Blob([typeof init.text === 'string' ? init.text : JSON.stringify(body)]),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeClient(overrides: Record<string, unknown> = {}): RawContentClient {
    return new RawContentClient({
        owner: 'testuser',
        repo: 'test-repo',
        ref: 'main',
        token: 'ghp_token',
        ...overrides,
    });
}

// ─── URL building ──────────────────────────────────────────────────────────

describe('RawContentClient — urlFor', () => {
    it('builds a raw URL for the configured owner/repo/ref', () => {
        const client = makeClient({ cacheBust: false });
        expect(client.urlFor('collections/users.json')).toBe(
            'https://raw.githubusercontent.com/testuser/test-repo/main/collections/users.json',
        );
    });

    it('encodes path segments without encoding the separators', () => {
        const client = makeClient({ cacheBust: false });
        expect(client.urlFor('files/task 1/photo (1).png')).toBe(
            'https://raw.githubusercontent.com/testuser/test-repo/main/files/task%201/photo%20(1).png',
        );
    });

    it('appends a unique cache-busting parameter by default', () => {
        const client = makeClient();
        const first = client.urlFor('meta.json');
        const second = client.urlFor('meta.json');

        expect(first).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.*meta\.json\?cb=/);
        expect(first).not.toBe(second);
    });

    it('honours a custom base URL and strips trailing slashes', () => {
        const client = makeClient({ baseUrl: 'https://raw.example.com/', cacheBust: false });
        expect(client.urlFor('meta.json')).toBe(
            'https://raw.example.com/testuser/test-repo/main/meta.json',
        );
    });
});

// ─── Successful reads ──────────────────────────────────────────────────────

describe('RawContentClient — reads', () => {
    it('returns parsed JSON and counts a hit', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ collection: 'users', version: 3 }));
        const client = makeClient();

        const result = await client.fetchJson('collections/users.json');

        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
            expect(result.value).toEqual({ collection: 'users', version: 3 });
        }
        expect(client.getStats().hits).toBe(1);
        expect(client.requestsSaved).toBe(1);
    });

    it('does not send an Authorization header for anonymous reads', async () => {
        fetchMock.mockResolvedValue(jsonResponse({}));
        const client = makeClient();

        await client.fetchJson('meta.json');

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers.Authorization).toBeUndefined();
        expect(init.cache).toBe('no-store');
    });

    it('returns a Blob for binary reads', async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
        fetchMock.mockResolvedValue(jsonResponse(null, { blob }));
        const client = makeClient();

        const result = await client.fetchBlob('files/photo.png');

        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.value).toBe(blob);
    });

    it('reports unavailable when the payload is not valid JSON', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { text: '<html>rate limited</html>' }));
        const client = makeClient();

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
        // The failed read must not be counted as a saved request
        expect(client.getStats().hits).toBe(0);
        expect(client.getStats().fallbacks).toBe(1);
    });
});

// ─── Public repositories ───────────────────────────────────────────────────

describe('RawContentClient — public repository', () => {
    it('trusts a 404 as "missing" and stays anonymous', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }));
        const client = makeClient();
        client.setRepoVisibility(false);

        const result = await client.fetchJson('collections/absent.json');

        expect(result.status).toBe('missing');
        expect(client.getStats().misses).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(client.usesAuthentication).toBe(false);
    });
});

// ─── Private repositories ──────────────────────────────────────────────────

describe('RawContentClient — private repository', () => {
    it('sends the token and trusts a 404 as "missing"', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }));
        const client = makeClient();
        client.setRepoVisibility(true);

        const result = await client.fetchJson('collections/absent.json');

        expect(result.status).toBe('missing');
        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer ghp_token');
    });

    it('reads content with the Authorization header', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ secret: true }));
        const client = makeClient();
        client.setRepoVisibility(true);

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('ok');
        expect(client.usesAuthentication).toBe(true);
    });

    it('disables raw content when an authenticated read is blocked by CORS', async () => {
        // Browsers reject the preflight for a non-simple Authorization header by
        // throwing a TypeError from fetch.
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient();
        client.setRepoVisibility(true);

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
        expect(client.available).toBe(false);
        expect(client.disabledReasonValue).toMatch(/CORS/i);

        // Every later read short-circuits without touching the network
        fetchMock.mockClear();
        const again = await client.fetchJson('meta.json');
        expect(again.status).toBe('unavailable');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never trusts an anonymous 404 on a private repository', async () => {
        fetchMock.mockImplementation(
            async (url: string, init: { headers?: Record<string, string> }) => {
                // Authenticated reads are blocked (CORS), anonymous ones 404
                if (init?.headers?.Authorization) throw new TypeError('Failed to fetch');
                return jsonResponse(null, { ok: false, status: 404 });
            },
        );

        const client = makeClient();
        // Visibility unknown: the client probes, gets blocked, then degrades
        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
    });
});

// ─── Visibility probing ────────────────────────────────────────────────────

describe('RawContentClient — unknown visibility', () => {
    it('probes the authenticated channel once when an anonymous read 404s', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 404 }))
            .mockResolvedValueOnce(jsonResponse({ probed: true }));

        const client = makeClient();
        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer ghp_token');
        // The authenticated channel works → keep using it
        expect(client.usesAuthentication).toBe(true);
    });

    it('reports unavailable when an anonymous 404 cannot be disambiguated', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }));
        const client = makeClient({ token: null });

        const result = await client.fetchJson('meta.json');

        // No token to probe with, and nothing has been read successfully yet —
        // the REST API has to decide whether the file exists.
        expect(result.status).toBe('unavailable');
    });

    it('trusts 404 after any successful read', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ ok: true }))
            .mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 404 }));

        const client = makeClient({ token: null });

        expect((await client.fetchJson('meta.json')).status).toBe('ok');
        expect((await client.fetchJson('collections/absent.json')).status).toBe('missing');
    });
});

// ─── Failure handling ──────────────────────────────────────────────────────

describe('RawContentClient — failures', () => {
    it('falls back on a network error and disables further raw reads', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient({ token: null });

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
        expect(client.available).toBe(false);
    });

    it('falls back on 401/403 for anonymous reads', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 403 }));
        const client = makeClient({ token: null });

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
        expect(client.available).toBe(false);
    });

    it('falls back on a 500 without disabling the channel', async () => {
        fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 500 }));
        const client = makeClient();

        const result = await client.fetchJson('meta.json');

        expect(result.status).toBe('unavailable');
        expect(client.available).toBe(true);
    });

    it('reports unavailable when fetch does not exist', async () => {
        vi.stubGlobal('fetch', undefined);
        const client = makeClient();

        expect(client.available).toBe(false);
        const result = await client.fetchJson('meta.json');
        expect(result.status).toBe('unavailable');
    });

    it('can be disabled explicitly', async () => {
        const client = makeClient();
        client.disable('turned off by the app');

        expect(client.available).toBe(false);
        expect((await client.fetchJson('meta.json')).status).toBe('unavailable');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ─── Stats ─────────────────────────────────────────────────────────────────

describe('RawContentClient — stats', () => {
    it('tracks hits, misses and fallbacks', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ a: 1 }))
            .mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 404 }))
            .mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 500 }));

        const client = makeClient();
        await client.fetchJson('meta.json');
        client.setRepoVisibility(false);
        await client.fetchJson('collections/absent.json');
        await client.fetchJson('collections/broken.json');

        const stats = client.getStats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(1);
        expect(stats.fallbacks).toBe(1);
        expect(client.requestsSaved).toBe(2);
    });

    it('resets stats on demand', async () => {
        fetchMock.mockResolvedValue(jsonResponse({}));
        const client = makeClient();
        await client.fetchJson('meta.json');
        expect(client.getStats().hits).toBe(1);

        client.resetStats();
        expect(client.getStats()).toEqual({ hits: 0, misses: 0, fallbacks: 0, bytes: 0 });
    });
});
