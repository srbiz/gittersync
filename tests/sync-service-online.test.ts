/**
 * GitterSync — Sync Service Online/Offline Tests
 *
 * Tests browser connectivity detection using jsdom environment.
 * Separated from the main sync-service test suite because these
 * tests require browser globals (window, navigator).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ─── Online / Offline Tests ─────────────────────────────────────────────────

describe('GitHubSyncService — online/offline', () => {
    let service: GitHubSyncService;
    // Captured event listeners: populated when startAutoSync registers them
    const listeners: Record<string, EventListener> = {};

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

        // Capture event listeners registered by the service
        vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
            listeners[type] = listener as EventListener;
        });
        vi.spyOn(window, 'removeEventListener').mockImplementation((type) => {
            delete listeners[type];
        });

        // Default to online
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

        vi.useFakeTimers();

        service = createService();
        await service.init('ghp_token');
    });

    afterEach(() => {
        service.stopAutoSync();
        vi.useRealTimers();
    });

    it('defaults to navigator.onLine status', () => {
        expect(service.isOnline).toBe(true);
    });

    it('registers online/offline event listeners on startAutoSync', () => {
        service.startAutoSync(10_000);

        expect(window.addEventListener).toHaveBeenCalledWith('online', expect.any(Function));
        expect(window.addEventListener).toHaveBeenCalledWith('offline', expect.any(Function));

        service.stopAutoSync();
    });

    it('removes event listeners on stopAutoSync', () => {
        service.startAutoSync(10_000);
        service.stopAutoSync();

        expect(window.removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
        expect(window.removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function));
    });

    it('skips sync cycles when offline', async () => {
        // Start auto-sync first so listeners are registered
        service.startAutoSync(10_000);

        // Fire the offline event (captured by the spy)
        listeners.offline?.(new Event('offline'));

        expect(service.isOnline).toBe(false);

        // Advance timers — sync should be skipped because offline
        vi.advanceTimersByTime(30_000);

        // No sync should have been attempted (no fetchJsonFile calls from pull)
        expect(mockApiFetchJsonFile).not.toHaveBeenCalled();

        service.stopAutoSync();
    });

    it('triggers immediate sync when online event fires', async () => {
        // Start auto-sync first so listeners are registered
        service.startAutoSync(10_000);

        // Go offline
        listeners.offline?.(new Event('offline'));
        expect(service.isOnline).toBe(false);

        // Come back online — should trigger immediate sync
        listeners.online?.(new Event('online'));
        expect(service.isOnline).toBe(true);

        // Flush the async doSync that the online handler triggers
        await vi.advanceTimersByTimeAsync(0);

        service.stopAutoSync();
    });

    it('includes isOnline in getStatus', () => {
        const status = service.getStatus();
        expect(status.isOnline).toBe(true);
    });

    it('includes isOnline in getFullStatus', async () => {
        const status = await service.getFullStatus();
        expect(status.isOnline).toBe(true);
    });

    it('updates isOnline when offline event fires', () => {
        // Start auto-sync to register listeners
        service.startAutoSync(10_000);

        listeners.offline?.(new Event('offline'));
        expect(service.isOnline).toBe(false);

        const status = service.getStatus();
        expect(status.isOnline).toBe(false);

        service.stopAutoSync();
    });

    it('updates isOnline when online event fires', () => {
        // Start auto-sync to register listeners
        service.startAutoSync(10_000);

        // Go offline first
        listeners.offline?.(new Event('offline'));
        expect(service.isOnline).toBe(false);

        // Come back online
        listeners.online?.(new Event('online'));
        expect(service.isOnline).toBe(true);

        service.stopAutoSync();
    });
});
