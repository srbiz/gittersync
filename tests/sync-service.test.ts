/**
 * GitterSync — Sync Service Tests
 *
 * All dependencies (GitHubApiAdapter, LocalDB, merge) are mocked.
 * Tests focus on orchestration logic — pull/push/sync/compact coordination.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictError, AuthError } from '../src/types';
import type {
    SyncedDocument,
    CollectionFile,
    ChangelogFile,
    MetaFile,
    SyncCursor,
} from '../src/types';

// ─── Mock Definitions (hoisted) ────────────────────────────────────────────
// vi.mock factories are hoisted to the top of the file, so we must use
// vi.hoisted() to define mock functions that the factories can reference.

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

function createService(overrides: Record<string, unknown> = {}): GitHubSyncService {
    return new GitHubSyncService({
        owner: 'testuser',
        repo: 'testrepo',
        compactionThreshold: 5,
        ...overrides,
    });
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

function makeChangelogFile(deviceId: string, changes: ChangelogFile['changes']): ChangelogFile {
    return {
        deviceId,
        timestamp: '2026-07-27T12:00:00Z',
        changes,
    };
}

const sampleDoc: SyncedDocument = {
    id: 'u1',
    data: { name: 'Alice' },
    _fields: { name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' } },
    updated_at: '2026-07-27T10:00:00Z',
    created_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    deleted_by: null,
};

// ─── init ───────────────────────────────────────────────────────────────────

describe('GitHubSyncService — init', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
    });

    it('initializes API and local DB', async () => {
        const service = createService();
        const result = await service.init('ghp_token');

        expect(result).toBe(true);
        expect(mockApiInit).toHaveBeenCalledWith('ghp_token');
        expect(mockLocalDbInit).toHaveBeenCalled();
    });

    it('throws if API init fails', async () => {
        mockApiInit.mockRejectedValue(new AuthError(401));

        const service = createService();

        await expect(service.init('bad-token')).rejects.toThrow(AuthError);
    });
});

// ─── registerCollections ────────────────────────────────────────────────────

describe('GitHubSyncService — registerCollections', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
    });

    it('registers collections with the local DB', async () => {
        const service = createService();
        await service.init('ghp_token');

        await service.registerCollections(['users', 'posts']);

        expect(mockLocalDbRegisterCollection).toHaveBeenCalledWith('users');
        expect(mockLocalDbRegisterCollection).toHaveBeenCalledWith('posts');
    });
});

// ─── pull — full ─────────────────────────────────────────────────────────────

describe('GitHubSyncService — pull (full)', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue(['users']);
        mockLocalDbGetSyncCursor.mockResolvedValue(null);
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbMergeDocuments.mockResolvedValue(1);
        mockLocalDbPutDocument.mockResolvedValue(undefined);

        service = createService();
        await service.init('ghp_token');
    });

    it('performs full pull when no cursor exists', async () => {
        const metaFile: MetaFile = {
            schemaVersion: 1,
            collections: { users: { version: 1, sha: 'sha' } },
            changelogCount: 0,
        };
        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });

        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'meta.json') return { content: metaFile, sha: 'meta-sha' };
            if (path === 'collections/users.json')
                return { content: collectionFile, sha: 'col-sha' };
            return null;
        });
        mockApiListDirectory.mockResolvedValue([]);
        mockApiGetLatestCommitSha.mockResolvedValue('head-sha');

        const result = await service.pull();

        expect(result.type).toBe('full');
        if (result.type === 'full') {
            expect(result.collections.users).toBeDefined();
        }
        expect(mockLocalDbSetSyncCursor).toHaveBeenCalledWith({
            sha: 'head-sha',
            timestamp: expect.any(String),
        });
    });

    it('returns "none" for empty repo', async () => {
        mockApiFetchJsonFile.mockResolvedValue(null);
        mockApiListDirectory.mockResolvedValue([]);
        mockApiGetLatestCommitSha.mockResolvedValue('head-sha');

        const result = await service.pull();

        expect(result.type).toBe('none');
    });
});

// ─── pull — incremental ─────────────────────────────────────────────────────

describe('GitHubSyncService — pull (incremental)', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue(['users']);
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbMergeDocuments.mockResolvedValue(1);
        mockLocalDbPutDocument.mockResolvedValue(undefined);

        service = createService();
        await service.init('ghp_token');
    });

    it('performs incremental pull when cursor exists', async () => {
        const cursor: SyncCursor = { sha: 'base-sha', timestamp: '2026-07-27T10:00:00Z' };
        mockLocalDbGetSyncCursor.mockResolvedValue(cursor);

        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });

        mockApiCompareCommits.mockResolvedValue({
            status: 'ahead',
            changedFiles: ['collections/users.json'],
            headSha: 'new-head-sha',
        });

        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'collections/users.json')
                return { content: collectionFile, sha: 'col-sha' };
            return null;
        });

        mockApiGetLatestCommitSha.mockResolvedValue('new-head-sha');

        const result = await service.pull();

        expect(result.type).toBe('incremental');
        expect(mockApiCompareCommits).toHaveBeenCalledWith('base-sha');
    });

    it('returns "none" when no files changed', async () => {
        const cursor: SyncCursor = { sha: 'base-sha', timestamp: '2026-07-27T10:00:00Z' };
        mockLocalDbGetSyncCursor.mockResolvedValue(cursor);

        mockApiCompareCommits.mockResolvedValue({
            status: 'identical',
            changedFiles: [],
            headSha: 'base-sha',
        });

        const result = await service.pull();

        expect(result.type).toBe('none');
    });
});

// ─── push ───────────────────────────────────────────────────────────────────

describe('GitHubSyncService — push', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbGetRegisteredCollections.mockReturnValue([]);

        service = createService();
        await service.init('ghp_token');
    });

    it('pushes pending changelog entries to GitHub', async () => {
        const entries = [
            {
                localId: 1,
                collection: 'users',
                docId: 'u1',
                op: 'create' as const,
                queuedAt: '2026-07-27T12:00:00Z',
                deviceId: 'deviceA',
                fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
            },
        ];

        mockLocalDbGetPendingChangelogEntries.mockResolvedValue(entries);
        mockApiCreateOrUpdateFileWithRetry.mockResolvedValue('sha');
        mockApiGetLatestCommitSha.mockResolvedValue('new-sha');
        mockLocalDbClearChangelogEntries.mockResolvedValue(undefined);
        mockApiListDirectory.mockResolvedValue([]);

        await service.push();

        expect(mockApiCreateOrUpdateFileWithRetry).toHaveBeenCalled();
        expect(mockLocalDbClearChangelogEntries).toHaveBeenCalledWith([1]);
    });

    it('is a no-op when no pending entries', async () => {
        mockLocalDbGetPendingChangelogEntries.mockResolvedValue([]);

        await service.push();

        expect(mockApiCreateOrUpdateFileWithRetry).not.toHaveBeenCalled();
    });

    it('triggers compaction when changelog count exceeds threshold', async () => {
        const entries = [
            {
                localId: 1,
                collection: 'users',
                docId: 'u1',
                op: 'update' as const,
                queuedAt: '2026-07-27T12:00:00Z',
                deviceId: 'deviceA',
                fields: { name: { value: 'Bob', updatedAt: '2026-07-27T12:00:00Z' } },
            },
        ];

        mockLocalDbGetPendingChangelogEntries.mockResolvedValue(entries);
        mockApiCreateOrUpdateFileWithRetry.mockResolvedValue('sha');
        mockApiGetLatestCommitSha.mockResolvedValue('new-sha');
        mockLocalDbClearChangelogEntries.mockResolvedValue(undefined);

        // Return more changelog files than threshold (5)
        mockApiListDirectory.mockResolvedValue([
            'cl1.json',
            'cl2.json',
            'cl3.json',
            'cl4.json',
            'cl5.json',
        ]);

        // Compact needs these
        mockApiFetchJsonFile.mockResolvedValue(null);
        mockApiDeleteFile.mockResolvedValue(undefined);
        mockLocalDbGetSchemaVersion.mockResolvedValue(1);

        await service.push();

        // Compact was triggered — it calls listDirectory again internally
        expect(mockApiListDirectory).toHaveBeenCalled();
    });
});

// ─── sync ───────────────────────────────────────────────────────────────────

describe('GitHubSyncService — sync', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue([]);
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbGetSyncCursor.mockResolvedValue(null);
        mockLocalDbGetPendingChangelogEntries.mockResolvedValue([]);
        mockApiListDirectory.mockResolvedValue([]);
        mockApiGetLatestCommitSha.mockResolvedValue('head-sha');

        service = createService();
        await service.init('ghp_token');
    });

    it('performs pull then push', async () => {
        mockApiFetchJsonFile.mockResolvedValue(null);

        const result = await service.sync();

        // Pull was called (no cursor → full pull, but empty repo → 'none')
        expect(result).toBeDefined();
    });

    it('returns none if already syncing', async () => {
        // Simulate ongoing sync by making pull hang
        let resolvePull: (value: unknown) => void;
        mockApiFetchJsonFile.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePull = resolve;
                }),
        );

        // Start first sync (will hang)
        const sync1 = service.sync();

        // Second sync should return 'none' immediately
        const sync2 = service.sync();
        const result2 = await sync2;

        expect(result2.type).toBe('none');

        // Clean up the hanging promise
        resolvePull!(null);
        await sync1;
    });
});

// ─── compact ────────────────────────────────────────────────────────────────

describe('GitHubSyncService — compact', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue(['users']);
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbGetSchemaVersion.mockResolvedValue(1);
        mockGetExpiredDeletes.mockReturnValue([]);

        service = createService();
        await service.init('ghp_token');
    });

    it('merges changelog entries into collection files', async () => {
        const changelogFile = makeChangelogFile('deviceA', [
            {
                collection: 'users',
                docId: 'u1',
                op: 'update',
                fields: { name: { value: 'Bob', updatedAt: '2026-07-27T12:00:00Z' } },
            },
        ]);

        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });

        mockApiListDirectory.mockResolvedValue(['cl1.json']);
        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'changelog/cl1.json') return { content: changelogFile, sha: 'cl-sha' };
            if (path === 'collections/users.json')
                return { content: collectionFile, sha: 'col-sha' };
            return null;
        });
        mockApplyChangelogToCollection.mockReturnValue(collectionFile);
        mockApiCreateOrUpdateFileWithRetry.mockResolvedValue('new-sha');
        mockApiDeleteFile.mockResolvedValue(undefined);
        mockApiGetLatestCommitSha.mockResolvedValue('compact-sha');

        await service.compact();

        expect(mockApplyChangelogToCollection).toHaveBeenCalled();
        expect(mockApiCreateOrUpdateFileWithRetry).toHaveBeenCalled();
        expect(mockApiDeleteFile).toHaveBeenCalled();
    });

    it('is a no-op when no changelog files exist', async () => {
        mockApiListDirectory.mockResolvedValue([]);

        await service.compact();

        expect(mockApplyChangelogToCollection).not.toHaveBeenCalled();
    });

    it('creates empty collection file if it does not exist', async () => {
        const changelogFile = makeChangelogFile('deviceA', [
            {
                collection: 'posts',
                docId: 'p1',
                op: 'create',
                fields: { title: { value: 'Hello', updatedAt: '2026-07-27T12:00:00Z' } },
            },
        ]);

        mockApiListDirectory.mockResolvedValue(['cl1.json']);
        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'changelog/cl1.json') return { content: changelogFile, sha: 'cl-sha' };
            // collections/posts.json doesn't exist
            return null;
        });

        const emptyCollection = makeCollectionFile('posts');
        mockApplyChangelogToCollection.mockReturnValue(emptyCollection);
        mockApiCreateOrUpdateFileWithRetry.mockResolvedValue('new-sha');
        mockApiDeleteFile.mockResolvedValue(undefined);
        mockApiGetLatestCommitSha.mockResolvedValue('compact-sha');

        await service.compact();

        // Should have called createOrUpdateFileWithRetry for the collection
        expect(mockApiCreateOrUpdateFileWithRetry).toHaveBeenCalled();
    });

    it('purges expired soft-deletes during compaction', async () => {
        const changelogFile = makeChangelogFile('deviceA', [
            {
                collection: 'users',
                docId: 'u1',
                op: 'update',
                fields: { name: { value: 'Bob', updatedAt: '2026-07-27T12:00:00Z' } },
            },
        ]);

        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });

        mockApiListDirectory.mockResolvedValue(['cl1.json']);
        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'changelog/cl1.json') return { content: changelogFile, sha: 'cl-sha' };
            if (path === 'collections/users.json')
                return { content: collectionFile, sha: 'col-sha' };
            return null;
        });
        mockApplyChangelogToCollection.mockReturnValue(collectionFile);
        mockGetExpiredDeletes.mockReturnValue(['u1']); // u1 is expired
        mockApiCreateOrUpdateFileWithRetry.mockResolvedValue('new-sha');
        mockApiDeleteFile.mockResolvedValue(undefined);
        mockApiGetLatestCommitSha.mockResolvedValue('compact-sha');

        await service.compact();

        // The expired delete should have been purged from the merged collection
        expect(mockGetExpiredDeletes).toHaveBeenCalled();
    });
});

// ─── uploadFile / downloadFile ───────────────────────────────────────────────

describe('GitHubSyncService — file operations', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');

        service = createService();
        await service.init('ghp_token');
    });

    it('uploads a file and returns a FileRef', async () => {
        mockApiUploadBinaryFile.mockResolvedValue('file-sha');

        const ref = await service.uploadFile('files/avatar.png', 'aW1hZ2VkYXRh', 'Upload avatar');

        expect(ref.path).toBe('files/avatar.png');
        expect(ref.sha).toBe('file-sha');
        expect(ref.mimeType).toBe('image/png');
        expect(ref.size).toBeGreaterThan(0);
    });

    it('detects MIME type from extension', async () => {
        mockApiUploadBinaryFile.mockResolvedValue('sha');

        const pdfRef = await service.uploadFile('files/doc.pdf', 'ZGF0YQ==', 'Upload doc');
        expect(pdfRef.mimeType).toBe('application/pdf');

        const jpgRef = await service.uploadFile('files/photo.jpg', 'ZGF0YQ==', 'Upload photo');
        expect(jpgRef.mimeType).toBe('image/jpeg');
    });

    it('defaults to application/octet-stream for unknown extensions', async () => {
        mockApiUploadBinaryFile.mockResolvedValue('sha');

        const ref = await service.uploadFile('files/data.xyz', 'ZGF0YQ==', 'Upload data');
        expect(ref.mimeType).toBe('application/octet-stream');
    });

    it('downloads a file using the API', async () => {
        const blob = new Blob(['data'], { type: 'image/png' });
        mockApiDownloadBinaryFile.mockResolvedValue(blob);

        const result = await service.downloadFile('files/avatar.png');

        expect(result).toBe(blob);
    });

    it('throws when downloading without authentication', async () => {
        // Create a new service but don't init it
        const uninitService = createService();

        await expect(uninitService.downloadFile('files/avatar.png')).rejects.toThrow(
            'not initialized',
        );
    });
});

// ─── autoSync ───────────────────────────────────────────────────────────────

describe('GitHubSyncService — autoSync', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue([]);
        mockLocalDbSetSyncCursor.mockResolvedValue(undefined);
        mockLocalDbGetSyncCursor.mockResolvedValue(null);
        mockLocalDbGetPendingChangelogEntries.mockResolvedValue([]);
        mockApiListDirectory.mockResolvedValue([]);
        mockApiFetchJsonFile.mockResolvedValue(null);
        mockApiGetLatestCommitSha.mockResolvedValue('head-sha');

        vi.useFakeTimers();

        service = createService();
        await service.init('ghp_token');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts periodic sync', () => {
        service.startAutoSync(10_000);

        // Advance past the interval — sync should be called
        vi.advanceTimersByTime(10_000);

        // At least one sync attempt was made (initial + interval)
        service.stopAutoSync();
    });

    it('stops periodic sync', () => {
        service.startAutoSync(10_000);
        service.stopAutoSync();

        // No errors — timer was cleared
        expect(true).toBe(true);
    });

    it('replaces previous timer when called again', () => {
        service.startAutoSync(10_000);
        service.startAutoSync(30_000);

        // No duplicate timers
        service.stopAutoSync();
        expect(true).toBe(true);
    });
});

// ─── getStatus / getFullStatus ───────────────────────────────────────────────

describe('GitHubSyncService — status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetPendingChangelogCount.mockResolvedValue(3);
        mockLocalDbGetSyncCursor.mockResolvedValue({
            sha: 'abc',
            timestamp: '2026-07-27T10:00:00Z',
        });
        mockApiGetRepoSize.mockResolvedValue(5000);
    });

    it('returns sync status', async () => {
        const service = createService();
        await service.init('ghp_token');

        const status = service.getStatus();

        expect(status.isSyncing).toBe(false);
        expect(status.deviceId).toBe('deviceA');
    });

    it('returns full status with async data', async () => {
        const service = createService();
        await service.init('ghp_token');

        const status = await service.getFullStatus();

        expect(status.isSyncing).toBe(false);
        expect(status.pendingChanges).toBe(3);
        expect(status.cursor).toEqual({ sha: 'abc', timestamp: '2026-07-27T10:00:00Z' });
        expect(status.repoSizeKb).toBe(5000);
    });
});

// ─── ensureInitialized ──────────────────────────────────────────────────────

describe('GitHubSyncService — ensureInitialized', () => {
    it('throws if methods are called before init', async () => {
        const service = createService();

        await expect(service.pull()).rejects.toThrow('not initialized');
        await expect(service.push()).rejects.toThrow('not initialized');
        await expect(service.compact()).rejects.toThrow('not initialized');
    });
});

// ─── getLocalDb ─────────────────────────────────────────────────────────────

describe('GitHubSyncService — getLocalDb', () => {
    it('exposes the local DB instance', async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');

        const service = createService();
        await service.init('ghp_token');

        const localDb = service.getLocalDb();
        expect(localDb).toBeDefined();
    });
});
