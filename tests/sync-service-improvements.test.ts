/**
 * @vitest-environment jsdom
 */

/**
 * GitterSync — Sync Service behaviour tests
 *
 * The GitHub adapter is replaced with an in-memory fake repository while the
 * **real** LocalDB (fake-indexeddb) is used, so these tests exercise the actual
 * orchestration: cursor handling, status caching, compaction and locking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ConflictError, ValidationError, RateLimitError } from '../src/types';
import type { SyncStatus, CollectionFile, SyncedDocument } from '../src/types';

// ─── Fake GitHub ───────────────────────────────────────────────────────────

interface FakeCommit {
    sha: string;
    files: string[];
}

function createFakeGitHub() {
    const files = new Map<string, string>();
    const commits: FakeCommit[] = [{ sha: 'commit-0', files: [] }];

    const state = {
        apiCalls: 0,
        failWrites: 0,
        failReads: 0,
        lastCommit: null as { sha: string; parentShas: string[] } | null,
        head: () => commits[commits.length - 1].sha,
        /** Commit a change to the fake repository directly (simulates another device) */
        remoteWrite(path: string, content: unknown, opts: { advanceHead?: boolean } = {}) {
            files.set(path, JSON.stringify(content, null, 2));
            if (opts.advanceHead !== false) {
                const sha = `commit-${commits.length}`;
                commits.push({ sha, files: [path] });
                state.lastCommit = { sha, parentShas: [commits[commits.length - 2].sha] };
            }
        },
        read(path: string) {
            const raw = files.get(path);
            return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
        },
        paths: () => [...files.keys()],
        /** Pretend the branch history was rewritten so `base` is unknown */
        orphanHistory() {
            commits.length = 0;
            commits.push({ sha: 'rewritten-head', files: [] });
        },
    };

    function localCommit(changedFiles: string[]): string {
        const sha = `commit-${commits.length}`;
        commits.push({ sha, files: changedFiles });
        state.lastCommit = { sha, parentShas: [commits[commits.length - 2].sha] };
        return sha;
    }

    const adapter = {
        init: vi.fn(async () => true),

        fetchJsonFile: vi.fn(async (path: string) => {
            state.apiCalls += 1;
            if (state.failReads > 0) {
                state.failReads -= 1;
                throw new Error('simulated read failure');
            }
            const raw = files.get(path);
            if (raw === undefined) return null;
            return { content: JSON.parse(raw), sha: `blob-${path}`, source: 'api' as const };
        }),

        fetchTextFile: vi.fn(async () => null),

        createOrUpdateFileWithRetry: vi.fn(async (path: string, content: string) => {
            const result = await adapter.writeFile(path, content, 'msg');
            return result.blobSha;
        }),

        writeFile: vi.fn(async (path: string, content: string) => {
            state.apiCalls += 1;
            if (state.failWrites > 0) {
                state.failWrites -= 1;
                // The real adapter translates a 409 into ConflictError after its
                // own retry budget is exhausted.
                throw new ConflictError(path, 3);
            }
            files.set(path, content);
            const commitSha = localCommit([path]);
            return {
                path,
                blobSha: `blob-${path}`,
                commitSha,
                parentShas: state.lastCommit?.parentShas ?? [],
            };
        }),

        deleteFile: vi.fn(async (path: string) => {
            state.apiCalls += 1;
            files.delete(path);
            localCommit([path]);
        }),

        compareCommits: vi.fn(async (base: string) => {
            state.apiCalls += 1;
            const index = commits.findIndex((c) => c.sha === base);
            if (index === -1) {
                return {
                    status: 'diverged',
                    changedFiles: [],
                    headSha: '',
                    aheadBy: 0,
                    behindBy: 0,
                };
            }
            if (index === commits.length - 1) {
                return {
                    status: 'identical',
                    changedFiles: [],
                    headSha: base,
                    aheadBy: 0,
                    behindBy: 0,
                };
            }
            const changedFiles = [...new Set(commits.slice(index + 1).flatMap((c) => c.files))];
            return {
                status: 'ahead',
                changedFiles,
                headSha: state.head(),
                aheadBy: commits.length - 1 - index,
                behindBy: 0,
            };
        }),

        getLatestCommitSha: vi.fn(async () => {
            state.apiCalls += 1;
            return state.head();
        }),

        listDirectory: vi.fn(async (dir: string) => {
            state.apiCalls += 1;
            const prefix = `${dir}/`;
            return [...files.keys()]
                .filter((p) => p.startsWith(prefix))
                .map((p) => p.slice(prefix.length))
                .filter((rest) => !rest.includes('/'));
        }),

        listDirectoryRecursive: vi.fn(async (dir: string) => {
            state.apiCalls += 1;
            const prefix = `${dir}/`;
            return [...files.keys()]
                .filter((p) => p.startsWith(prefix))
                .map((p) => p.slice(prefix.length));
        }),

        uploadBinaryFile: vi.fn(async (path: string) => {
            state.apiCalls += 1;
            files.set(path, '"binary"');
            localCommit([path]);
            return `blob-${path}`;
        }),

        downloadBinaryFile: vi.fn(async () => new Blob(['binary'])),

        getRepoSize: vi.fn(async () => {
            state.apiCalls += 1;
            return 1234;
        }),

        getCachedRepoSize: () => 1234,
        getLastCommit: () => state.lastCommit,
        getUsage: () => ({
            apiCalls: state.apiCalls,
            rawReads: 0,
            rawMisses: 0,
            rawFallbacks: 0,
        }),
        resetUsage: () => {
            state.apiCalls = 0;
        },
        clearShaCache: () => {},

        rateLimitRemaining: 4999 as number | null,
        rateLimitResetAt: null as Date | null,
        rawContentActive: false,
        repoIsPrivate: false,
        owner: 'testuser',
        repo: 'testrepo',
        branch: 'main',
        compactionThreshold: 20,
        deleteRetentionMs: 30 * 24 * 60 * 60 * 1000,
    };

    return { adapter, state };
}

const fakeHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../src/github-api', () => ({
    GitHubApiAdapter: vi.fn().mockImplementation(() => fakeHolder.current),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { GitHubSyncService } from '../src/sync-service';

// ─── Harness ───────────────────────────────────────────────────────────────

const DB_NAMES = ['gittersync', 'gittersync_collections'];

async function cleanupDatabases(): Promise<void> {
    for (const name of DB_NAMES) {
        await Promise.race([
            new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
    }
}

/** Let fire-and-forget work (the immediate auto-sync cycle) settle. */
function settle(ms = 60): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let fake: ReturnType<typeof createFakeGitHub>;
let service: GitHubSyncService;
const statuses: SyncStatus[] = [];

async function createService(config: Record<string, unknown> = {}): Promise<GitHubSyncService> {
    fake = createFakeGitHub();
    fakeHolder.current = fake.adapter;
    statuses.length = 0;

    const instance = new GitHubSyncService({
        owner: 'testuser',
        repo: 'testrepo',
        onSyncStatusChange: (status) => statuses.push(status),
        ...config,
    });
    await instance.init('ghp_token');
    return instance;
}

function collectionFile(name: string, documents: Record<string, SyncedDocument>): CollectionFile {
    return { collection: name, version: 1, updatedAt: '2026-08-01T00:00:00.000Z', documents };
}

function doc(
    id: string,
    data: Record<string, unknown>,
    updatedAt = '2026-08-01T00:00:00.000Z',
): SyncedDocument {
    const fields: Record<string, { updatedAt: string; device: string }> = {};
    for (const key of Object.keys(data)) fields[key] = { updatedAt, device: 'remote-device' };
    return {
        id,
        data,
        _fields: fields,
        updated_at: updatedAt,
        created_at: updatedAt,
        deleted_at: null,
        deleted_by: null,
    };
}

beforeEach(async () => {
    await cleanupDatabases();
});

afterEach(async () => {
    service?.stopAutoSync();
    // Closing the Dexie connections first keeps deleteDatabase from blocking on
    // an in-flight transaction.
    try {
        await service?.getLocalDb().close();
    } catch {
        // ignore
    }
    await cleanupDatabases();
});

// ─── Status ────────────────────────────────────────────────────────────────

describe('GitHubSyncService — status reporting', () => {
    it('reports a populated status synchronously', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        const status = service.getStatus();

        expect(status.isInitialized).toBe(true);
        expect(status.isSyncing).toBe(false);
        expect(status.isOnline).toBe(true);
        expect(status.deviceId).toBeTruthy();
        expect(status.pendingChanges).toBe(0);
        expect(status.cursor).toBeNull();
        expect(status.lastSyncAt).toBeNull();
        expect(status.repoSizeKb).toBe(1234);
        expect(status.rateLimitRemaining).toBe(4999);
    });

    it('reflects local writes and the sync cursor in the cached status', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        const db = service.getLocalDb();

        await db.create('tasks', 't1', { title: 'one' });
        expect(service.getStatus().pendingChanges).toBe(0); // not refreshed yet

        await service.getFullStatus();
        expect(service.getStatus().pendingChanges).toBe(1);

        fake.state.remoteWrite('collections/tasks.json', collectionFile('tasks', {}));
        await service.pull();

        const status = service.getStatus();
        expect(status.cursor?.sha).toBeTruthy();
        expect(status.lastSyncAt).toBeTruthy();
        expect(status.pendingChanges).toBe(1);
    });

    it('emits status changes to the callback', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses[statuses.length - 1].isInitialized).toBe(true);
    });

    it('exposes rate limit and transport info', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.pull();

        const info = service.getRateLimitInfo();
        expect(info.remaining).toBe(4999);
        expect(info.apiCalls).toBeGreaterThan(0);
        expect(info.rawContentActive).toBe(false);
    });

    it('refreshes the repo size in getFullStatus', async () => {
        service = await createService();
        const status = await service.getFullStatus();
        expect(status.repoSizeKb).toBe(1234);
        expect(fake.adapter.getRepoSize).toHaveBeenCalled();
    });

    it('keeps the last known repo size when the lookup fails', async () => {
        service = await createService();
        (fake.adapter.getRepoSize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error('offline'),
        );
        const status = await service.getFullStatus();
        expect(status.repoSizeKb).toBe(1234);
    });
});

// ─── Cursor safety ─────────────────────────────────────────────────────────

describe('GitHubSyncService — sync cursor handling', () => {
    it('does not install a cursor when pushing before ever pulling', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.getLocalDb().create('tasks', 't1', { title: 'one' });

        const result = await service.push();

        expect(result.pushed).toBe(1);
        expect(result.changelogPath).toMatch(/^changelog\/.+\.json$/);
        // A device that never pulled must keep doing full pulls, otherwise it
        // would skip the repository's existing history.
        expect(service.getStatus().cursor).toBeNull();
        expect(fake.adapter.getLatestCommitSha).not.toHaveBeenCalled();
    });

    it('advances the cursor using the commit created by the push', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.pull(); // installs a cursor at the current head

        const cursorBefore = service.getStatus().cursor!.sha;
        fake.adapter.getLatestCommitSha.mockClear();

        await service.getLocalDb().create('tasks', 't1', { title: 'one' });
        await service.push();

        const cursorAfter = service.getStatus().cursor!.sha;
        expect(cursorAfter).not.toBe(cursorBefore);
        expect(fake.adapter.getLastCommit()!.parentShas).toContain(cursorBefore);
        // No extra round trip to resolve the head
        expect(fake.adapter.getLatestCommitSha).not.toHaveBeenCalled();
    });

    it('leaves the cursor alone when another device committed in between', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.pull();
        const cursorBefore = service.getStatus().cursor!.sha;

        // Another device pushes while we are editing locally
        fake.state.remoteWrite('changelog/other-device.json', { deviceId: 'other', changes: [] });

        await service.getLocalDb().create('tasks', 't1', { title: 'one' });
        await service.push();

        // The cursor stays behind, so the next pull still sees the other device's
        // changelog instead of skipping it forever.
        expect(service.getStatus().cursor!.sha).toBe(cursorBefore);
    });

    it('installs a cursor after a full pull of an empty repository', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        const result = await service.pull();

        expect(result.type).toBe('none');
        expect(service.getStatus().cursor?.sha).toBe('commit-0');
    });

    it('falls back to a full pull when the cursor is no longer resolvable', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite(
            'collections/tasks.json',
            collectionFile('tasks', { r1: doc('r1', { title: 'remote' }) }),
        );
        await service.pull();
        expect(service.getStatus().cursor).not.toBeNull();

        // Someone force-pushes: our cursor points at a commit that no longer exists
        fake.state.orphanHistory();
        fake.state.remoteWrite(
            'collections/tasks.json',
            collectionFile('tasks', { r2: doc('r2', { title: 'after rewrite' }) }),
            { advanceHead: false },
        );

        const result = await service.pull();

        expect(result.type).toBe('full');
        const docs = await service.getLocalDb().getAllDocuments<{ title: string }>('tasks');
        expect(docs.map((d) => d.id).sort()).toEqual(['r1', 'r2']);
        expect(service.getStatus().cursor?.sha).toBe('rewritten-head');
    });

    it('returns none without downloading when nothing changed', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite('collections/tasks.json', collectionFile('tasks', {}));
        await service.pull();

        fake.adapter.fetchJsonFile.mockClear();
        const result = await service.pull();

        expect(result.type).toBe('none');
        expect(fake.adapter.fetchJsonFile).not.toHaveBeenCalled();
    });

    it('reports how many REST calls a pull consumed', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite(
            'collections/tasks.json',
            collectionFile('tasks', { r1: doc('r1', {}) }),
        );

        const result = await service.pull();

        expect(result.type).toBe('full');
        if (result.type === 'full') {
            expect(result.apiCalls).toBeGreaterThan(0);
            expect(result.rawReads).toBe(0);
        }
    });
});

// ─── Push ──────────────────────────────────────────────────────────────────

describe('GitHubSyncService — push', () => {
    it('batches pending changes into one changelog file', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        const db = service.getLocalDb();

        await db.create('tasks', 't1', { title: 'one' });
        await db.create('tasks', 't2', { title: 'two' });

        const result = await service.push();

        expect(result.pushed).toBe(2);
        const written = fake.state.read(result.changelogPath!) as { changes: unknown[] };
        expect(written.changes).toHaveLength(2);
        expect(await db.getPendingChangelogCount()).toBe(0);
    });

    it('does nothing when the queue is empty', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        const result = await service.push();

        expect(result).toMatchObject({ pushed: 0, changelogPath: null, compacted: false });
        expect(fake.adapter.writeFile).not.toHaveBeenCalled();
    });

    it('compacts when the changelog directory reaches the threshold', async () => {
        service = await createService({ compactionThreshold: 2 });
        await service.registerCollections(['tasks']);

        // Pre-existing changelog from another device
        fake.state.remoteWrite('changelog/other.json', {
            deviceId: 'other',
            timestamp: '2026-08-01T00:00:00.000Z',
            changes: [
                {
                    collection: 'tasks',
                    docId: 'remote-1',
                    op: 'create',
                    fields: {
                        title: {
                            value: 'from other device',
                            updatedAt: '2026-08-01T00:00:00.000Z',
                        },
                    },
                },
            ],
        });

        await service.getLocalDb().create('tasks', 't1', { title: 'one' });
        const result = await service.push();

        expect(result.compacted).toBe(true);
        // Changelogs were merged into the collection file and removed
        expect(fake.state.paths().some((p) => p.startsWith('changelog/'))).toBe(false);
        const compacted = fake.state.read('collections/tasks.json') as CollectionFile;
        expect(Object.keys(compacted.documents).sort()).toEqual(['remote-1', 't1']);
    });

    it('falls back to a head lookup when the adapter reports no commit', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.pull();
        (fake.adapter.getLastCommit as unknown as () => null) = () => null;

        await service.getLocalDb().create('tasks', 't1', { title: 'one' });
        await service.push();

        expect(fake.adapter.getLatestCommitSha).toHaveBeenCalled();
    });
});

// ─── Sync ──────────────────────────────────────────────────────────────────

describe('GitHubSyncService — sync', () => {
    it('pulls then pushes', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite(
            'collections/tasks.json',
            collectionFile('tasks', { r1: doc('r1', { title: 'remote' }) }),
        );
        await service.getLocalDb().create('tasks', 't1', { title: 'local' });

        const result = await service.sync();

        expect(result.type).toBe('full');
        const docs = await service.getLocalDb().getAllDocuments('tasks');
        expect(docs.map((d) => d.id).sort()).toEqual(['r1', 't1']);
        expect(await service.getLocalDb().getPendingChangelogCount()).toBe(0);
    });

    it('retries a bounded number of times on conflict', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        service = await createService({ maxRetries: 2, retryBaseDelay: 1 });
        await service.registerCollections(['tasks']);
        await service.getLocalDb().create('tasks', 't1', { title: 'one' });

        // Every write conflicts
        fake.state.failWrites = 99;

        await expect(service.sync()).rejects.toBeInstanceOf(ConflictError);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('serialises overlapping operations instead of interleaving them', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.getLocalDb().create('tasks', 't1', { title: 'one' });

        // Two pushes at once: the second must not run while the first is writing
        const [first, second] = await Promise.all([service.push(), service.push()]);

        expect(first.pushed).toBe(1);
        expect(second.pushed).toBe(0);
        expect(fake.state.paths().filter((p) => p.startsWith('changelog/'))).toHaveLength(1);
    });

    it('skips a sync that is already running', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        service = await createService();
        await service.registerCollections(['tasks']);

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (fake.adapter.fetchJsonFile as ReturnType<typeof vi.fn>).mockImplementationOnce(
            async () => {
                await gate;
                return null;
            },
        );

        const running = service.sync();
        await vi.waitFor(() => expect(fake.adapter.fetchJsonFile).toHaveBeenCalled());

        const skipped = await service.sync();
        expect(skipped.type).toBe('none');

        release();
        await running;
        warn.mockRestore();
    });
});

// ─── Compaction ────────────────────────────────────────────────────────────

describe('GitHubSyncService — compaction', () => {
    it('purges soft-deletes only after the configured retention window', async () => {
        const retention = 60_000; // one minute, for the test
        service = await createService({ deleteRetentionMs: retention });
        await service.registerCollections(['tasks']);

        const old = new Date(Date.now() - 10 * 60_000).toISOString();
        const fresh = new Date().toISOString();

        fake.state.remoteWrite('changelog/old.json', {
            deviceId: 'other',
            timestamp: old,
            changes: [
                { collection: 'tasks', docId: 'gone', op: 'delete', deletedAt: old },
                { collection: 'tasks', docId: 'kept', op: 'delete', deletedAt: fresh },
            ],
        });

        const result = await service.compact();

        expect(result.changelogsCompacted).toBe(1);
        expect(result.purgedDeletes).toBe(1);
        const compacted = fake.state.read('collections/tasks.json') as CollectionFile;
        expect(Object.keys(compacted.documents)).toEqual(['kept']);
    });

    it('writes meta.json with the registered collections', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite('changelog/c1.json', {
            deviceId: 'other',
            timestamp: '2026-08-01T00:00:00.000Z',
            changes: [
                {
                    collection: 'tasks',
                    docId: 't1',
                    op: 'create',
                    fields: { title: { value: 'x', updatedAt: '2026-08-01T00:00:00.000Z' } },
                },
            ],
        });

        await service.compact();

        const meta = fake.state.read('meta.json') as { collections: Record<string, unknown> };
        expect(Object.keys(meta.collections)).toEqual(['tasks']);
    });

    it('records the changelog files that survive the compaction', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite('changelog/c1.json', {
            deviceId: 'other',
            timestamp: '2026-08-01T00:00:00.000Z',
            changes: [
                {
                    collection: 'tasks',
                    docId: 't1',
                    op: 'create',
                    fields: { title: { value: 'x', updatedAt: '2026-08-01T00:00:00.000Z' } },
                },
            ],
        });

        // Another device pushes a changelog while this compaction is deleting c1.
        const realDelete = fake.adapter.deleteFile.getMockImplementation()!;
        fake.adapter.deleteFile.mockImplementationOnce(async (path: string) => {
            await realDelete(path);
            fake.state.remoteWrite('changelog/c2.json', {
                deviceId: 'third-device',
                timestamp: '2026-08-02T00:00:00.000Z',
                changes: [],
            });
        });

        await service.compact();

        // meta.json must not claim the repository is free of changelogs, or the
        // next push's compaction check would never notice c2.
        const meta = fake.state.read('meta.json') as { changelogCount: number };
        expect(meta.changelogCount).toBe(1);
        expect(fake.state.paths()).toContain('changelog/c2.json');
    });

    it('is a no-op when there is nothing to compact', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        const result = await service.compact();

        expect(result).toMatchObject({ changelogsCompacted: 0, collectionsWritten: [] });
    });
});

// ─── Files ─────────────────────────────────────────────────────────────────

describe('GitHubSyncService — file operations', () => {
    it('accepts a Blob and reports the exact size', async () => {
        service = await createService();
        const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' });

        const ref = await service.uploadFile('files/t1/photo.png', blob);

        expect(ref).toMatchObject({ path: 'files/t1/photo.png', size: 5, mimeType: 'image/png' });
        expect(ref.sha).toBeTruthy();
    });

    it('accepts base64 strings, Uint8Array and ArrayBuffer payloads', async () => {
        service = await createService();

        const fromBase64 = await service.uploadFile('files/a.bin', 'aGVsbG8=');
        const fromBytes = await service.uploadFile('files/b.bin', new Uint8Array([1, 2, 3]));
        const fromBuffer = await service.uploadFile('files/c.bin', new Uint8Array([1, 2]).buffer);

        expect(fromBase64.size).toBe(5);
        expect(fromBytes.size).toBe(3);
        expect(fromBuffer.size).toBe(2);
    });

    it('accepts a data URL and strips the prefix', async () => {
        service = await createService();
        const ref = await service.uploadFile(
            'files/a.bin',
            'data:application/octet-stream;base64,aGVsbG8=',
        );
        expect(ref.size).toBe(5);
    });

    it('infers the MIME type and allows an override', async () => {
        service = await createService();

        expect((await service.uploadFile('files/doc.pdf', 'aGk=')).mimeType).toBe(
            'application/pdf',
        );
        expect((await service.uploadFile('files/x.unknown', 'aGk=')).mimeType).toBe(
            'application/octet-stream',
        );
        expect((await service.uploadFile('files/x.bin', 'aGk=', 'msg', 'text/csv')).mimeType).toBe(
            'text/csv',
        );
    });

    it('defaults the commit message', async () => {
        service = await createService();
        await service.uploadFile('files/photo.png', 'aGk=');

        expect(fake.adapter.uploadBinaryFile).toHaveBeenCalledWith(
            'files/photo.png',
            'aGk=',
            'Upload photo.png',
        );
    });

    it('rejects unsafe paths and uninitialised usage', async () => {
        service = await createService();
        await expect(service.uploadFile('../escape.png', 'aGk=')).rejects.toThrow(ValidationError);
        await expect(service.downloadFile('/abs.png')).rejects.toThrow(ValidationError);

        const fresh = new GitHubSyncService({ owner: 'a', repo: 'b' });
        await expect(fresh.uploadFile('files/x.png', 'aGk=')).rejects.toThrow('not initialized');
    });

    it('downloads, deletes and lists files', async () => {
        service = await createService();
        fake.state.remoteWrite('files/t1/a.png', 'x');

        expect(await service.downloadFile('files/t1/a.png')).toBeInstanceOf(Blob);
        expect(await service.listFiles('files')).toEqual(['t1/a.png']);

        await service.deleteFile('files/t1/a.png');
        expect(fake.state.paths()).not.toContain('files/t1/a.png');
    });
});

// ─── Validation & lifecycle ────────────────────────────────────────────────

describe('GitHubSyncService — validation and lifecycle', () => {
    it('rejects invalid collection names', async () => {
        service = await createService();
        await expect(service.registerCollections(['ok', 'not/ok'])).rejects.toThrow(
            ValidationError,
        );
        await expect(service.registerCollections('nope' as never)).rejects.toThrow(ValidationError);
    });

    it('rejects an invalid configuration at construction time', () => {
        expect(() => new GitHubSyncService({ owner: '', repo: 'x' })).toThrow(ValidationError);
        expect(
            () => new GitHubSyncService({ owner: 'x', repo: 'y', compactionThreshold: -1 }),
        ).toThrow(ValidationError);
    });

    it('exposes the resolved configuration', async () => {
        service = await createService({ compactionThreshold: 7 });
        expect(service.getConfig()).toMatchObject({
            owner: 'testuser',
            branch: 'main',
            compactionThreshold: 7,
            useRawContent: true,
        });
    });

    it('resets local data without touching the remote', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        fake.state.remoteWrite(
            'collections/tasks.json',
            collectionFile('tasks', { r1: doc('r1', {}) }),
        );
        await service.pull();
        await service.getLocalDb().create('tasks', 'local', { title: 'x' });

        await service.reset();

        expect(await service.getLocalDb().getAllDocuments('tasks')).toHaveLength(0);
        expect(await service.getLocalDb().getPendingChangelogCount()).toBe(0);
        expect(service.getStatus().cursor).toBeNull();
        expect(service.getStatus().lastSyncAt).toBeNull();
        // Remote untouched
        expect(fake.state.read('collections/tasks.json')).toBeDefined();
    });

    it('destroy stops auto-sync and marks the service unusable', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        vi.useFakeTimers();
        try {
            service.startAutoSync(1000);
            expect(service.autoSyncRunning).toBe(true);
            // Let the immediate cycle finish (IndexedDB work is scheduled on
            // immediates, which fake timers control)
            await vi.advanceTimersByTimeAsync(0);

            await service.destroy();

            expect(service.autoSyncRunning).toBe(false);
            expect(service.getStatus().isInitialized).toBe(false);
            await expect(service.pull()).rejects.toThrow('not initialized');
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports pending changes on demand', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.getLocalDb().create('tasks', 't1', { title: 'one' });

        expect(await service.getPendingChanges()).toBe(1);
        expect(service.getStatus().pendingChanges).toBe(1);
    });
});

// ─── Auto sync ─────────────────────────────────────────────────────────────

describe('GitHubSyncService — auto sync', () => {
    it('pauses cycles while rate limited', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            service = await createService();
            await service.registerCollections(['tasks']);
            // Install a cursor so cycles take the incremental path, which is the
            // one that hits the compare endpoint.
            await service.pull();

            const resetAt = new Date(Date.now() + 60_000);
            (fake.adapter.compareCommits as ReturnType<typeof vi.fn>).mockRejectedValue(
                new RateLimitError(resetAt, 0),
            );

            service.startAutoSync(1000);

            await vi.waitFor(
                () => expect(warn).toHaveBeenCalledWith(expect.stringContaining('paused until')),
                { timeout: 2000 },
            );

            // While the rate-limit window is closed, no further cycle is started
            const callsBefore = (fake.adapter.compareCommits as ReturnType<typeof vi.fn>).mock.calls
                .length;
            await settle(1200);
            expect(
                (fake.adapter.compareCommits as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBe(callsBefore);

            service.stopAutoSync();
            await settle();
        } finally {
            warn.mockRestore();
        }
    });

    it('resumes when connectivity returns', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        await service.pull();

        const callsBefore = (fake.adapter.compareCommits as ReturnType<typeof vi.fn>).mock.calls
            .length;
        service.startAutoSync(60_000); // interval long enough not to fire during the test
        await settle();

        // The immediate cycle ran
        expect((fake.adapter.compareCommits as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
            callsBefore + 1,
        );

        service.stopAutoSync();
        await settle();
    });

    it('reports the running state and interval', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);
        expect(service.autoSyncRunning).toBe(false);

        service.startAutoSync(1234);
        expect(service.autoSyncRunning).toBe(true);
        expect(service.autoSyncInterval).toBe(1234);

        service.stopAutoSync();
        expect(service.autoSyncRunning).toBe(false);
        await settle();
    });

    it('never accepts an interval below one second', async () => {
        service = await createService();
        await service.registerCollections(['tasks']);

        service.startAutoSync(10);
        expect(service.autoSyncInterval).toBe(1000);
        service.stopAutoSync();
        await settle();
    });
});
