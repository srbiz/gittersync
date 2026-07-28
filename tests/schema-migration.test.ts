/**
 * GitterSync — Schema Migration Tests
 *
 * Tests the migration pipeline that runs during pull when the remote
 * schemaVersion is higher than the local one. Migrations transform
 * collection documents before they are merged into the local database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    SyncedDocument,
    CollectionFile,
    ChangelogFile,
    MetaFile,
    MigrationStep,
} from '../src/types';

// ─── Mock Definitions (hoisted) ────────────────────────────────────────────

const {
    mockApiInit,
    mockApiFetchJsonFile,
    mockApiCreateOrUpdateFileWithRetry,
    mockApiCompareCommits,
    mockApiGetLatestCommitSha,
    mockApiListDirectory,
    mockApiDeleteFile,
    mockApiUploadBinaryFile,
    mockApiDownloadBinaryFile,
    mockApiGetRepoSize,
    mockLocalDbInit,
    mockLocalDbGetDeviceId,
    mockLocalDbRegisterCollection,
    mockLocalDbGetRegisteredCollections,
    mockLocalDbGetSyncCursor,
    mockLocalDbSetSyncCursor,
    mockLocalDbGetDocument,
    mockLocalDbPutDocument,
    mockLocalDbMergeDocuments,
    mockLocalDbReplaceCollection,
    mockLocalDbGetPendingChangelogEntries,
    mockLocalDbGetPendingChangelogCount,
    mockLocalDbClearChangelogEntries,
    mockLocalDbQueueChangelogEntry,
    mockLocalDbGetSchemaVersion,
    mockLocalDbSetSchemaVersion,
    mockMergeDocument,
    mockApplyChangelogToCollection,
    mockGetExpiredDeletes,
} = vi.hoisted(() => ({
    mockApiInit: vi.fn(),
    mockApiFetchJsonFile: vi.fn(),
    mockApiCreateOrUpdateFileWithRetry: vi.fn(),
    mockApiCompareCommits: vi.fn(),
    mockApiGetLatestCommitSha: vi.fn(),
    mockApiListDirectory: vi.fn(),
    mockApiDeleteFile: vi.fn(),
    mockApiUploadBinaryFile: vi.fn(),
    mockApiDownloadBinaryFile: vi.fn(),
    mockApiGetRepoSize: vi.fn(),
    mockLocalDbInit: vi.fn(),
    mockLocalDbGetDeviceId: vi.fn(),
    mockLocalDbRegisterCollection: vi.fn(),
    mockLocalDbGetRegisteredCollections: vi.fn(),
    mockLocalDbGetSyncCursor: vi.fn(),
    mockLocalDbSetSyncCursor: vi.fn(),
    mockLocalDbGetDocument: vi.fn(),
    mockLocalDbPutDocument: vi.fn(),
    mockLocalDbMergeDocuments: vi.fn(),
    mockLocalDbReplaceCollection: vi.fn(),
    mockLocalDbGetPendingChangelogEntries: vi.fn(),
    mockLocalDbGetPendingChangelogCount: vi.fn(),
    mockLocalDbClearChangelogEntries: vi.fn(),
    mockLocalDbQueueChangelogEntry: vi.fn(),
    mockLocalDbGetSchemaVersion: vi.fn(),
    mockLocalDbSetSchemaVersion: vi.fn(),
    mockMergeDocument: vi.fn(),
    mockApplyChangelogToCollection: vi.fn(),
    mockGetExpiredDeletes: vi.fn(),
}));

vi.mock('../src/github-api', () => ({
    GitHubApiAdapter: vi.fn().mockImplementation(() => ({
        init: mockApiInit,
        fetchJsonFile: mockApiFetchJsonFile,
        createOrUpdateFileWithRetry: mockApiCreateOrUpdateFileWithRetry,
        compareCommits: mockApiCompareCommits,
        getLatestCommitSha: mockApiGetLatestCommitSha,
        listDirectory: mockApiListDirectory,
        deleteFile: mockApiDeleteFile,
        uploadBinaryFile: mockApiUploadBinaryFile,
        downloadBinaryFile: mockApiDownloadBinaryFile,
        getRepoSize: mockApiGetRepoSize,
        rateLimitRemaining: null,
        owner: 'testuser',
        repo: 'testrepo',
        branch: 'main',
        compactionThreshold: 20,
    })),
}));

vi.mock('../src/local-db', () => ({
    LocalDB: vi.fn().mockImplementation(() => ({
        init: mockLocalDbInit,
        getDeviceId: mockLocalDbGetDeviceId,
        registerCollection: mockLocalDbRegisterCollection,
        getRegisteredCollections: mockLocalDbGetRegisteredCollections,
        getSyncCursor: mockLocalDbGetSyncCursor,
        setSyncCursor: mockLocalDbSetSyncCursor,
        getDocument: mockLocalDbGetDocument,
        putDocument: mockLocalDbPutDocument,
        mergeDocuments: mockLocalDbMergeDocuments,
        replaceCollection: mockLocalDbReplaceCollection,
        getPendingChangelogEntries: mockLocalDbGetPendingChangelogEntries,
        getPendingChangelogCount: mockLocalDbGetPendingChangelogCount,
        clearChangelogEntries: mockLocalDbClearChangelogEntries,
        queueChangelogEntry: mockLocalDbQueueChangelogEntry,
        getSchemaVersion: mockLocalDbGetSchemaVersion,
        setSchemaVersion: mockLocalDbSetSchemaVersion,
    })),
}));

vi.mock('../src/merge', () => ({
    mergeDocument: mockMergeDocument,
    applyChangelogToCollection: mockApplyChangelogToCollection,
    getExpiredDeletes: mockGetExpiredDeletes,
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { GitHubSyncService } from '../src/sync-service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createService(migrations: MigrationStep[] = []): GitHubSyncService {
    return new GitHubSyncService({
        owner: 'testuser',
        repo: 'testrepo',
        compactionThreshold: 5,
        migrations,
    });
}

function makeDoc(id: string, data: Record<string, unknown> = {}): SyncedDocument {
    return {
        id,
        data,
        _fields: Object.fromEntries(
            Object.keys(data).map((key) => [
                key,
                { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            ]),
        ),
        updated_at: '2026-07-27T10:00:00Z',
        created_at: '2026-07-01T00:00:00Z',
        deleted_at: null,
        deleted_by: null,
    };
}

function makeCollectionFile(
    name: string,
    docs: Record<string, SyncedDocument> = {},
): CollectionFile {
    return {
        collection: name,
        version: 1,
        updatedAt: '2026-07-27T10:00:00Z',
        documents: docs,
    };
}

function makeMeta(schemaVersion: number, collectionNames: string[] = []): MetaFile {
    return {
        schemaVersion,
        collections: Object.fromEntries(
            collectionNames.map((name) => [name, { version: 1, sha: `sha-${name}` }]),
        ),
        changelogCount: 0,
    };
}

/** Set up all the standard mocks for a full pull scenario */
function setupFullPullMocks(options: {
    meta: MetaFile | null;
    collections: Record<string, CollectionFile>;
    localSchemaVersion: number;
    changelogs?: ChangelogFile[];
}) {
    const { meta, collections, localSchemaVersion, changelogs = [] } = options;

    // No cursor → triggers fullPull
    mockLocalDbGetSyncCursor.mockResolvedValue(null);

    // Meta.json fetch
    mockApiFetchJsonFile.mockImplementation((path: string) => {
        if (path === 'meta.json') {
            return meta ? { content: meta } : null;
        }
        if (path.startsWith('collections/')) {
            const name = path.replace('collections/', '').replace('.json', '');
            if (collections[name]) {
                return { content: collections[name] };
            }
        }
        if (path.startsWith('changelog/')) {
            const changelog = changelogs.find(
                (c) => path === `changelog/${c.timestamp.replace(/[:.]/g, '-')}_${c.deviceId}.json`,
            );
            if (changelog) return { content: changelog };
        }
        return null;
    });

    // Collections are registered
    mockLocalDbGetRegisteredCollections.mockReturnValue(Object.keys(collections));

    // No changelog files in directory
    mockApiListDirectory.mockResolvedValue([]);

    // Schema version
    mockLocalDbGetSchemaVersion.mockResolvedValue(localSchemaVersion);

    // Merge document stub
    mockLocalDbMergeDocuments.mockImplementation(
        (local: unknown, remote: SyncedDocument) => remote,
    );

    // Commit SHA for cursor update
    mockApiGetLatestCommitSha.mockResolvedValue('sha-new');
}

/** Set up all the standard mocks for an incremental pull scenario */
function setupIncrementalPullMocks(options: {
    meta: MetaFile | null;
    changedCollections: Record<string, CollectionFile>;
    localSchemaVersion: number;
    changedFiles?: string[];
}) {
    const { meta, changedCollections, localSchemaVersion, changedFiles } = options;

    // Has cursor → triggers incrementalPull
    mockLocalDbGetSyncCursor.mockResolvedValue({
        sha: 'sha-old',
        timestamp: '2026-07-27T10:00:00Z',
    });

    // Compare commits returns changed files
    const files =
        changedFiles ?? Object.keys(changedCollections).map((name) => `collections/${name}.json`);
    mockApiCompareCommits.mockResolvedValue({
        status: 'ahead',
        changedFiles: files,
    });

    // Fetch files
    mockApiFetchJsonFile.mockImplementation((path: string) => {
        if (path === 'meta.json') {
            return meta ? { content: meta } : null;
        }
        if (path.startsWith('collections/')) {
            const name = path.replace('collections/', '').replace('.json', '');
            if (changedCollections[name]) {
                return { content: changedCollections[name] };
            }
        }
        return null;
    });

    // Collections are registered
    mockLocalDbGetRegisteredCollections.mockReturnValue(Object.keys(changedCollections));

    // Schema version
    mockLocalDbGetSchemaVersion.mockResolvedValue(localSchemaVersion);

    // Merge document stub
    mockLocalDbMergeDocuments.mockImplementation(
        (local: unknown, remote: SyncedDocument) => remote,
    );

    // Commit SHA for cursor update
    mockApiGetLatestCommitSha.mockResolvedValue('sha-new');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Schema Migration — fullPull', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
    });

    it('runs a single migration when remote schemaVersion > local', async () => {
        const transform = vi.fn((_collection, documents, _meta) => {
            // Add a "version" field to every document
            const result: Record<string, SyncedDocument> = {};
            for (const [id, doc] of Object.entries(documents) as [string, SyncedDocument][]) {
                result[id] = {
                    ...doc,
                    data: { ...(doc.data as Record<string, unknown>), version: 1 },
                };
            }
            return result;
        });

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(transform).toHaveBeenCalledOnce();
        expect(transform).toHaveBeenCalledWith(
            'users',
            expect.objectContaining({ u1: expect.any(Object) }),
            meta,
        );

        // Schema version should be updated
        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(1);
    });

    it('runs multiple migrations in order', async () => {
        const order: number[] = [];

        const migration1: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform: vi.fn((collection, documents, _meta) => {
                order.push(1);
                const result: Record<string, SyncedDocument> = {};
                for (const [id, doc] of Object.entries(documents) as [string, SyncedDocument][]) {
                    result[id] = {
                        ...doc,
                        data: { ...(doc.data as Record<string, unknown>), version: 1 },
                    };
                }
                return result;
            }),
        };

        const migration2: MigrationStep = {
            from: 1,
            to: 2,
            description: 'Add status field',
            transform: vi.fn((collection, documents, _meta) => {
                order.push(2);
                const result: Record<string, SyncedDocument> = {};
                for (const [id, doc] of Object.entries(documents) as [string, SyncedDocument][]) {
                    result[id] = {
                        ...doc,
                        data: { ...(doc.data as Record<string, unknown>), status: 'active' },
                    };
                }
                return result;
            }),
        };

        const service = createService([migration1, migration2]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(2, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(order).toEqual([1, 2]);

        // Both migrations should have been called
        expect(migration1.transform).toHaveBeenCalledOnce();
        expect(migration2.transform).toHaveBeenCalledOnce();

        // Schema version should be updated to the remote version
        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(2);
    });

    it('updates local schema version even with no migrations configured', async () => {
        const service = createService(); // No migrations
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(3, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(3);
    });

    it('does not run migrations when local version equals remote', async () => {
        const transform = vi.fn((_c, docs) => docs);

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 1, // Same as remote
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(transform).not.toHaveBeenCalled();
        // Schema version should NOT be updated since it's already current
        expect(mockLocalDbSetSchemaVersion).not.toHaveBeenCalled();
    });

    it('does not run migrations when local version is greater than remote', async () => {
        const transform = vi.fn((_c, docs) => docs);

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 2, // Greater than remote
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(transform).not.toHaveBeenCalled();
        expect(mockLocalDbSetSchemaVersion).not.toHaveBeenCalled();
    });

    it('migration transforms only the specified collection', async () => {
        const transform = vi.fn((collection, documents, _meta) => {
            // Only transform the "users" collection, pass others through
            if (collection !== 'users') return documents;

            const result: Record<string, SyncedDocument> = {};
            for (const [id, doc] of Object.entries(documents) as [string, SyncedDocument][]) {
                result[id] = {
                    ...doc,
                    data: { ...(doc.data as Record<string, unknown>), migrated: true },
                };
            }
            return result;
        });

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add migrated flag to users only',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const userDoc = makeDoc('u1', { name: 'Alice' });
        const postDoc = makeDoc('p1', { title: 'Hello' });
        const meta = makeMeta(1, ['users', 'posts']);
        const usersCollection = makeCollectionFile('users', { u1: userDoc });
        const postsCollection = makeCollectionFile('posts', { p1: postDoc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection, posts: postsCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        // Transform called once for each collection
        expect(transform).toHaveBeenCalledTimes(2);

        // First call is for 'users', second for 'posts'
        expect(transform).toHaveBeenNthCalledWith(1, 'users', expect.any(Object), meta);
        expect(transform).toHaveBeenNthCalledWith(2, 'posts', expect.any(Object), meta);

        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(1);
    });

    it('handles empty collections without error', async () => {
        const transform = vi.fn((_c, docs) => docs);

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Empty collections test',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', {}); // No documents

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        expect(transform).toHaveBeenCalledOnce();
        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(1);
    });

    it('does not run migrations when meta is null', async () => {
        const transform = vi.fn((_c, docs) => docs);

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Should not run',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        // null meta means empty repo → returns 'none' before migrations
        setupFullPullMocks({
            meta: null,
            collections: {},
            localSchemaVersion: 0,
        });

        // Mock guessCollectionNames to return empty
        mockApiListDirectory.mockResolvedValue([]);

        const result = await service.pull();

        expect(result.type).toBe('none');
        expect(transform).not.toHaveBeenCalled();
    });

    it('skips migrations that do not match the version range', async () => {
        const transform0to1 = vi.fn((_c, docs) => docs);
        const transform1to2 = vi.fn((_c, docs) => docs);
        const transform2to3 = vi.fn((_c, docs) => docs);

        const service = createService([
            { from: 0, to: 1, description: 'v0 to v1', transform: transform0to1 },
            { from: 1, to: 2, description: 'v1 to v2', transform: transform1to2 },
            { from: 2, to: 3, description: 'v2 to v3', transform: transform2to3 },
        ]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(2, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupFullPullMocks({
            meta,
            collections: { users: usersCollection },
            localSchemaVersion: 1, // Only v1→v2 should run
        });

        const result = await service.pull();

        expect(result.type).toBe('full');
        // v0→v1 should be skipped (from < localVersion)
        expect(transform0to1).not.toHaveBeenCalled();
        // v1→v2 should run
        expect(transform1to2).toHaveBeenCalledOnce();
        // v2→v3 should be skipped (to > remoteVersion)
        expect(transform2to3).not.toHaveBeenCalled();

        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(2);
    });
});

describe('Schema Migration — incrementalPull', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
    });

    it('runs migrations during incremental pull', async () => {
        const transform = vi.fn((_collection, documents, _meta) => {
            const result: Record<string, SyncedDocument> = {};
            for (const [id, doc] of Object.entries(documents) as [string, SyncedDocument][]) {
                result[id] = {
                    ...doc,
                    data: { ...(doc.data as Record<string, unknown>), version: 1 },
                };
            }
            return result;
        });

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupIncrementalPullMocks({
            meta,
            changedCollections: { users: usersCollection },
            localSchemaVersion: 0,
        });

        const result = await service.pull();

        expect(result.type).toBe('incremental');
        expect(transform).toHaveBeenCalledOnce();
        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(1);
    });

    it('skips migrations during incremental pull when versions match', async () => {
        const transform = vi.fn((_c, docs) => docs);

        const migration: MigrationStep = {
            from: 0,
            to: 1,
            description: 'Add version field',
            transform,
        };

        const service = createService([migration]);
        await service.init('ghp_token');

        const doc = makeDoc('u1', { name: 'Alice' });
        const meta = makeMeta(1, ['users']);
        const usersCollection = makeCollectionFile('users', { u1: doc });

        setupIncrementalPullMocks({
            meta,
            changedCollections: { users: usersCollection },
            localSchemaVersion: 1, // Already at remote version
        });

        const result = await service.pull();

        expect(result.type).toBe('incremental');
        expect(transform).not.toHaveBeenCalled();
        expect(mockLocalDbSetSchemaVersion).not.toHaveBeenCalled();
    });
});
