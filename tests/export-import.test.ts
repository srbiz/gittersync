/**
 * GitterSync — Export/Import Tests
 *
 * Tests for exportData() and importData() methods.
 * All dependencies (GitHubApiAdapter, LocalDB, JSZip) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '../src/types';
import type {
    SyncedDocument,
    CollectionFile,
    ChangelogFile,
    MetaFile,
    ExportManifest,
} from '../src/types';

// ─── Mock Definitions (hoisted) ────────────────────────────────────────────

const {
    mockApiInit,
    mockApiFetchJsonFile,
    mockApiListDirectory,
    mockApiListDirectoryRecursive,
    mockApiDownloadBinaryFile,
    mockLocalDbInit,
    mockLocalDbGetDeviceId,
    mockLocalDbGetRegisteredCollections,
    mockLocalDbRegisterCollection,
    mockLocalDbReplaceCollection,
    mockLocalDbClearSyncCursor,
    mockLocalDbGetSchemaVersion,
    mockLocalDbSetSchemaVersion,
} = vi.hoisted(() => ({
    mockApiInit: vi.fn(),
    mockApiFetchJsonFile: vi.fn(),
    mockApiListDirectory: vi.fn(),
    mockApiListDirectoryRecursive: vi.fn(),
    mockApiDownloadBinaryFile: vi.fn(),
    mockLocalDbInit: vi.fn(),
    mockLocalDbGetDeviceId: vi.fn(),
    mockLocalDbGetRegisteredCollections: vi.fn(),
    mockLocalDbRegisterCollection: vi.fn(),
    mockLocalDbReplaceCollection: vi.fn(),
    mockLocalDbClearSyncCursor: vi.fn(),
    mockLocalDbGetSchemaVersion: vi.fn(),
    mockLocalDbSetSchemaVersion: vi.fn(),
}));

vi.mock('../src/github-api', () => ({
    GitHubApiAdapter: vi.fn().mockImplementation(() => ({
        init: mockApiInit,
        fetchJsonFile: mockApiFetchJsonFile,
        listDirectory: mockApiListDirectory,
        listDirectoryRecursive: mockApiListDirectoryRecursive,
        downloadBinaryFile: mockApiDownloadBinaryFile,
        getLatestCommitSha: vi.fn(),
        createOrUpdateFileWithRetry: vi.fn(),
        rateLimitRemaining: null,
        owner: 'testuser',
        repo: 'testrepo',
        branch: 'main',
    })),
}));

vi.mock('../src/local-db', () => ({
    LocalDB: vi.fn().mockImplementation(() => ({
        init: mockLocalDbInit,
        getDeviceId: mockLocalDbGetDeviceId,
        getRegisteredCollections: mockLocalDbGetRegisteredCollections,
        registerCollection: mockLocalDbRegisterCollection,
        replaceCollection: mockLocalDbReplaceCollection,
        clearSyncCursor: mockLocalDbClearSyncCursor,
        getSchemaVersion: mockLocalDbGetSchemaVersion,
        setSchemaVersion: mockLocalDbSetSchemaVersion,
    })),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { GitHubSyncService } from '../src/sync-service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createService(overrides: Record<string, unknown> = {}): GitHubSyncService {
    return new GitHubSyncService({
        owner: 'testuser',
        repo: 'testrepo',
        ...overrides,
    });
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GitHubSyncService — exportData', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');

        service = createService();
        await service.init('ghp_token');
    });

    it('exports data from populated GitHub repo', async () => {
        const metaFile: MetaFile = {
            schemaVersion: 1,
            collections: { users: { version: 1, sha: 'sha' } },
            changelogCount: 0,
        };
        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });
        const changelogFile: ChangelogFile = {
            deviceId: 'deviceA',
            timestamp: '2026-07-27T12:00:00Z',
            changes: [
                {
                    collection: 'users',
                    docId: 'u1',
                    op: 'create',
                    fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
                },
            ],
        };

        mockApiFetchJsonFile.mockImplementation(async (path: string) => {
            if (path === 'meta.json') return { content: metaFile, sha: 'meta-sha' };
            if (path === 'collections/users.json')
                return { content: collectionFile, sha: 'col-sha' };
            if (path === 'changelog/cl1.json') return { content: changelogFile, sha: 'cl-sha' };
            return null;
        });

        mockApiListDirectory.mockImplementation(async (path: string) => {
            if (path === 'changelog') return ['cl1.json'];
            return [];
        });
        mockApiListDirectoryRecursive.mockResolvedValue(['avatar.png']);

        const uint8 = new TextEncoder().encode('fake-image-data');
        mockApiDownloadBinaryFile.mockResolvedValue(uint8);

        const result = await service.exportData();

        // Should return a Blob
        expect(result).toBeInstanceOf(Blob);
        expect(result.type).toBe('application/zip');

        // Verify API calls
        expect(mockApiFetchJsonFile).toHaveBeenCalledWith('meta.json');
        expect(mockApiFetchJsonFile).toHaveBeenCalledWith('collections/users.json');
        expect(mockApiListDirectory).toHaveBeenCalledWith('changelog');
        expect(mockApiListDirectoryRecursive).toHaveBeenCalledWith('files');
        expect(mockApiDownloadBinaryFile).toHaveBeenCalledWith('files/avatar.png');
    });

    it('exports with empty repo (no collections)', async () => {
        mockApiFetchJsonFile.mockResolvedValue(null);
        mockApiListDirectory.mockResolvedValue([]);
        mockApiListDirectoryRecursive.mockResolvedValue([]);

        const result = await service.exportData();

        expect(result).toBeInstanceOf(Blob);
        // Should still produce a valid ZIP with just manifest
        expect(result.size).toBeGreaterThan(0);
    });

    it('includes binary files in the export', async () => {
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

        mockApiListDirectory.mockImplementation(async (path: string) => {
            if (path === 'changelog') return [];
            return [];
        });
        mockApiListDirectoryRecursive.mockResolvedValue(['avatar.png', 'doc.pdf']);

        const pngUint8 = new TextEncoder().encode('png-data');
        const pdfUint8 = new TextEncoder().encode('pdf-data');
        mockApiDownloadBinaryFile.mockImplementation(async (path: string) => {
            if (path === 'files/avatar.png') return pngUint8;
            if (path === 'files/doc.pdf') return pdfUint8;
            return new Uint8Array(0);
        });

        const result = await service.exportData();

        expect(result).toBeInstanceOf(Blob);
        expect(mockApiDownloadBinaryFile).toHaveBeenCalledTimes(2);
    });

    it('skips binary files that fail to download', async () => {
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

        mockApiListDirectory.mockImplementation(async (path: string) => {
            if (path === 'changelog') return [];
            if (path === 'files') return ['avatar.png', 'broken.pdf'];
            return [];
        });

        const pngUint8 = new TextEncoder().encode('png-data');
        mockApiDownloadBinaryFile.mockImplementation(async (path: string) => {
            if (path === 'files/avatar.png') return pngUint8;
            throw new Error('File not found');
        });

        // Should not throw — broken files are skipped
        const result = await service.exportData();
        expect(result).toBeInstanceOf(Blob);
    });
});

describe('GitHubSyncService — importData', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');
        mockLocalDbGetRegisteredCollections.mockReturnValue([]);
        mockLocalDbGetSchemaVersion.mockResolvedValue(0);

        service = createService();
        await service.init('ghp_token');
    });

    async function createValidZip(
        includeManifest = true,
        includeCollections = true,
        nested = false,
    ): Promise<Blob> {
        // Use dynamic import since jszip is a real dependency
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        const prefix = nested ? 'gittersync-export/' : '';

        if (includeManifest) {
            const manifest: ExportManifest = {
                exportedAt: '2026-07-28T12:00:00Z',
                sourceVersion: '1.3.1',
                collections: ['users'],
                changelogCount: 0,
                fileCount: 0,
            };
            zip.file(`${prefix}manifest.json`, JSON.stringify(manifest));
        }

        if (includeCollections) {
            const collectionFile = makeCollectionFile('users', { u1: sampleDoc });
            zip.file(`${prefix}collections/users.json`, JSON.stringify(collectionFile));
        }

        return zip.generateAsync({ type: 'blob' });
    }

    it('imports a valid ZIP file', async () => {
        const zipBlob = await createValidZip();

        await service.importData(zipBlob);

        expect(mockLocalDbRegisterCollection).toHaveBeenCalledWith('users');
        expect(mockLocalDbReplaceCollection).toHaveBeenCalledWith('users', {
            u1: sampleDoc,
        });
        expect(mockLocalDbClearSyncCursor).toHaveBeenCalled();
    });

    it('imports a nested ZIP (gittersync-export/ prefix)', async () => {
        const zipBlob = await createValidZip(true, true, true);

        await service.importData(zipBlob);

        expect(mockLocalDbRegisterCollection).toHaveBeenCalledWith('users');
        expect(mockLocalDbReplaceCollection).toHaveBeenCalledWith('users', {
            u1: sampleDoc,
        });
        expect(mockLocalDbClearSyncCursor).toHaveBeenCalled();
    });

    it('throws ValidationError for non-ZIP file', async () => {
        const invalidBlob = new Blob(['not a zip file'], { type: 'text/plain' });

        await expect(service.importData(invalidBlob)).rejects.toThrow(ValidationError);
        await expect(service.importData(invalidBlob)).rejects.toThrow(
            'Invalid or corrupted ZIP file',
        );
    });

    it('throws ValidationError for ZIP missing manifest.json', async () => {
        const zipBlob = await createValidZip(false, true);

        await expect(service.importData(zipBlob)).rejects.toThrow(ValidationError);
        await expect(service.importData(zipBlob)).rejects.toThrow('missing manifest.json');
    });

    it('throws ValidationError for ZIP with no collection files', async () => {
        const zipBlob = await createValidZip(true, false);

        await expect(service.importData(zipBlob)).rejects.toThrow(ValidationError);
        await expect(service.importData(zipBlob)).rejects.toThrow('no collection files');
    });

    it('preserves local device ID (does not overwrite it)', async () => {
        const zipBlob = await createValidZip();

        await service.importData(zipBlob);

        // Device ID should not have been modified
        expect(mockLocalDbGetDeviceId).not.toHaveBeenCalledWith(expect.anything());
        // clearSyncCursor should still be called
        expect(mockLocalDbClearSyncCursor).toHaveBeenCalled();
    });

    it('updates schema version from meta.json', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        const manifest: ExportManifest = {
            exportedAt: '2026-07-28T12:00:00Z',
            sourceVersion: '1.3.1',
            collections: ['users'],
            changelogCount: 0,
            fileCount: 0,
        };
        zip.file('manifest.json', JSON.stringify(manifest));

        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });
        zip.file('collections/users.json', JSON.stringify(collectionFile));

        const meta: MetaFile = {
            schemaVersion: 3,
            collections: { users: { version: 1, sha: 'sha' } },
            changelogCount: 0,
        };
        zip.file('meta.json', JSON.stringify(meta));

        const zipBlob = await zip.generateAsync({ type: 'blob' });

        await service.importData(zipBlob);

        expect(mockLocalDbSetSchemaVersion).toHaveBeenCalledWith(3);
    });

    it('does not call setSchemaVersion if meta.json has no schemaVersion', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        const manifest: ExportManifest = {
            exportedAt: '2026-07-28T12:00:00Z',
            sourceVersion: '1.3.1',
            collections: ['users'],
            changelogCount: 0,
            fileCount: 0,
        };
        zip.file('manifest.json', JSON.stringify(manifest));

        const collectionFile = makeCollectionFile('users', { u1: sampleDoc });
        zip.file('collections/users.json', JSON.stringify(collectionFile));

        // meta.json without schemaVersion
        zip.file('meta.json', JSON.stringify({ collections: {} }));

        const zipBlob = await zip.generateAsync({ type: 'blob' });

        await service.importData(zipBlob);

        expect(mockLocalDbSetSchemaVersion).not.toHaveBeenCalled();
    });
});

// ─── Export ZIP layout ─────────────────────────────────────────────────────

describe('GitHubSyncService — exportData ZIP layout', () => {
    let service: GitHubSyncService;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockApiInit.mockResolvedValue(true);
        mockLocalDbInit.mockResolvedValue('deviceA');
        mockLocalDbGetDeviceId.mockReturnValue('deviceA');

        service = createService();
        await service.init('ghp_token');
    });

    it('nests all entries under the documented gittersync-export/ folder', async () => {
        const JSZip = (await import('jszip')).default;

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
        mockApiListDirectoryRecursive.mockResolvedValue([]);
        mockApiListDirectoryRecursive.mockResolvedValue(['avatar.png']);
        mockApiDownloadBinaryFile.mockResolvedValue(new TextEncoder().encode('img'));

        const blob = await service.exportData();
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

        expect(entries.sort()).toEqual(
            [
                'gittersync-export/collections/users.json',
                'gittersync-export/files/avatar.png',
                'gittersync-export/manifest.json',
                'gittersync-export/meta.json',
            ].sort(),
        );

        // Every entry must live inside the folder — nothing leaks to the root
        for (const entry of entries) {
            expect(entry.startsWith('gittersync-export/')).toBe(true);
        }
    });

    it('reports the current library version in the manifest', async () => {
        const JSZip = (await import('jszip')).default;
        const { LIBRARY_VERSION } = await import('../src/version');
        const pkg = (await import('../package.json', { with: { type: 'json' } })).default;

        mockApiFetchJsonFile.mockResolvedValue(null);
        mockApiListDirectory.mockResolvedValue([]);
        mockApiListDirectoryRecursive.mockResolvedValue([]);

        const blob = await service.exportData();
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const manifest = JSON.parse(
            await zip.file('gittersync-export/manifest.json')!.async('string'),
        ) as ExportManifest;

        expect(manifest.sourceVersion).toBe(LIBRARY_VERSION);
        // Guard against version drift between the constant and package.json
        expect(LIBRARY_VERSION).toBe(pkg.version);
    });
});
