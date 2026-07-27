/**
 * GitterSync — GitHub API Adapter Tests
 *
 * All Octokit calls are mocked — no real API requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubApiAdapter } from '../src/github-api';
import { ConflictError, AuthError } from '../src/types';
import type { GitHubSyncConfig } from '../src/types';

// ─── Mock Octokit ───────────────────────────────────────────────────────────

const mockReposGet = vi.fn();
const mockReposGetContent = vi.fn();
const mockReposCreateOrUpdateFileContents = vi.fn();
const mockReposDeleteFile = vi.fn();
const mockReposCompareCommits = vi.fn();
const mockReposListCommits = vi.fn();

vi.mock('@octokit/rest', () => ({
    Octokit: vi.fn().mockImplementation(() => ({
        repos: {
            get: mockReposGet,
            getContent: mockReposGetContent,
            createOrUpdateFileContents: mockReposCreateOrUpdateFileContents,
            deleteFile: mockReposDeleteFile,
            compareCommits: mockReposCompareCommits,
            listCommits: mockReposListCommits,
        },
    })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createAdapter(overrides: Partial<GitHubSyncConfig> = {}): GitHubApiAdapter {
    return new GitHubApiAdapter({
        owner: 'testuser',
        repo: 'test-repo',
        branch: 'main',
        ...overrides,
    });
}

function encodeContent(obj: unknown): string {
    const json = JSON.stringify(obj);
    return btoa(json);
}

function makeFileResponse(content: string, sha = 'file-sha-123') {
    return {
        data: {
            type: 'file',
            content,
            sha,
            name: 'test.json',
            path: 'test.json',
            size: 100,
            url: '',
            html_url: '',
            git_url: '',
            download_url: '',
        },
        status: 200,
    };
}

function makeDirResponse(files: { name: string; type: string }[]) {
    return {
        data: files.map((f) => ({
            name: f.name,
            type: f.type,
            path: `collections/${f.name}`,
            sha: 'sha',
            size: 100,
            url: '',
            html_url: '',
            git_url: '',
            download_url: '',
        })),
        status: 200,
    };
}

// ─── init ───────────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — init', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('initializes successfully with a valid token', async () => {
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });

        const adapter = createAdapter();
        const result = await adapter.init('ghp_valid_token');

        expect(result).toBe(true);
        expect(mockReposGet).toHaveBeenCalledWith({
            owner: 'testuser',
            repo: 'test-repo',
        });
    });

    it('throws AuthError on 401', async () => {
        const error = new Error('Unauthorized');
        (error as any).status = 401;
        mockReposGet.mockRejectedValue(error);

        const adapter = createAdapter();

        await expect(adapter.init('bad-token')).rejects.toThrow(AuthError);
    });

    it('throws AuthError on 403', async () => {
        const error = new Error('Forbidden');
        (error as any).status = 403;
        mockReposGet.mockRejectedValue(error);

        const adapter = createAdapter();

        await expect(adapter.init('forbidden-token')).rejects.toThrow(AuthError);
    });

    it('throws generic error on other failures', async () => {
        const error = new Error('Server error');
        (error as any).status = 500;
        mockReposGet.mockRejectedValue(error);

        const adapter = createAdapter();

        await expect(adapter.init('token')).rejects.toThrow('Failed to access repo');
    });
});

// ─── fetchJsonFile ──────────────────────────────────────────────────────────

describe('GitHubApiAdapter — fetchJsonFile', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('fetches and decodes a JSON file', async () => {
        const content = encodeContent({ collection: 'users', version: 1 });
        mockReposGetContent.mockResolvedValue(makeFileResponse(content));

        const result = await adapter.fetchJsonFile('collections/users.json');

        expect(result).not.toBeNull();
        expect(result!.content).toEqual({ collection: 'users', version: 1 });
        expect(result!.sha).toBe('file-sha-123');
    });

    it('returns null on 404', async () => {
        const error = new Error('Not Found');
        (error as any).status = 404;
        mockReposGetContent.mockRejectedValue(error);

        const result = await adapter.fetchJsonFile('collections/nonexistent.json');

        expect(result).toBeNull();
    });

    it('throws AuthError on 401/403', async () => {
        const error = new Error('Forbidden');
        (error as any).status = 403;
        mockReposGetContent.mockRejectedValue(error);

        await expect(adapter.fetchJsonFile('collections/users.json')).rejects.toThrow(AuthError);
    });
});

// ─── createOrUpdateFile ─────────────────────────────────────────────────────

describe('GitHubApiAdapter — createOrUpdateFile', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('creates a new file when it does not exist', async () => {
        // File doesn't exist → 404
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        // Create file
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'new-file-sha' } },
        });

        const sha = await adapter.createOrUpdateFile(
            'collections/users.json',
            '{"collection":"users"}',
            'Create users',
        );

        expect(sha).toBe('new-file-sha');
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'collections/users.json',
                message: 'Create users',
                sha: undefined,
                branch: 'main',
            }),
        );
    });

    it('updates an existing file using its SHA', async () => {
        // File exists → return SHA
        mockReposGetContent.mockResolvedValue(
            makeFileResponse(encodeContent({ collection: 'users' }), 'existing-sha'),
        );

        // Update file
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'updated-file-sha' } },
        });

        const sha = await adapter.createOrUpdateFile(
            'collections/users.json',
            '{"collection":"users","version":2}',
            'Update users',
        );

        expect(sha).toBe('updated-file-sha');
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
            expect.objectContaining({
                sha: 'existing-sha',
            }),
        );
    });

    it('throws if no SHA returned from create', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: null },
        });

        await expect(adapter.createOrUpdateFile('test.json', '{}', 'test')).rejects.toThrow(
            'no SHA returned',
        );
    });
});

// ─── createOrUpdateFileWithRetry ─────────────────────────────────────────────

describe('GitHubApiAdapter — createOrUpdateFileWithRetry', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter({ maxRetries: 3, retryBaseDelay: 10 });
        await adapter.init('ghp_token');
    });

    it('succeeds on first try if no conflict', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);
        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'sha' } },
        });

        const sha = await adapter.createOrUpdateFileWithRetry('test.json', '{}', 'test');

        expect(sha).toBe('sha');
    });

    it('retries on 409 Conflict and eventually succeeds', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        const conflictError = new Error('Conflict');
        (conflictError as any).status = 409;

        // Fail once, then succeed
        mockReposCreateOrUpdateFileContents
            .mockRejectedValueOnce(conflictError)
            .mockResolvedValueOnce({ data: { content: { sha: 'sha-after-retry' } } });

        const sha = await adapter.createOrUpdateFileWithRetry('test.json', '{}', 'test');

        expect(sha).toBe('sha-after-retry');
    });

    it('throws after max retries exhausted on 409', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        const conflictError = new Error('Conflict');
        (conflictError as any).status = 409;

        mockReposCreateOrUpdateFileContents.mockRejectedValue(conflictError);

        await expect(
            adapter.createOrUpdateFileWithRetry('test.json', '{}', 'test'),
        ).rejects.toThrow(ConflictError);
    });

    it('re-throws non-409 errors immediately', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        const serverError = new Error('Internal Server Error');
        (serverError as any).status = 500;
        mockReposCreateOrUpdateFileContents.mockRejectedValue(serverError);

        await expect(
            adapter.createOrUpdateFileWithRetry('test.json', '{}', 'test'),
        ).rejects.toThrow('Internal Server Error');
    });
});

// ─── deleteFile ─────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — deleteFile', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('deletes a file by its SHA', async () => {
        mockReposGetContent.mockResolvedValue(makeFileResponse('{}', 'file-sha'));
        mockReposDeleteFile.mockResolvedValue({ data: {} });

        await adapter.deleteFile('test.json', 'Delete test');

        expect(mockReposDeleteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'test.json',
                sha: 'file-sha',
                message: 'Delete test',
            }),
        );
    });

    it('is a no-op on 404 (file already deleted)', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        await expect(adapter.deleteFile('test.json', 'Delete test')).resolves.toBeUndefined();
    });
});

// ─── compareCommits ─────────────────────────────────────────────────────────

describe('GitHubApiAdapter — compareCommits', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('returns changed files from comparison', async () => {
        mockReposCompareCommits.mockResolvedValue({
            data: {
                status: 'ahead',
                files: [
                    { filename: 'collections/users.json' },
                    { filename: 'changelog/2026-07-27_deviceA.json' },
                ],
                merge_base_commit: { sha: 'new-head-sha' },
            },
        });

        const result = await adapter.compareCommits('base-sha');

        expect(result.status).toBe('ahead');
        expect(result.changedFiles).toEqual([
            'collections/users.json',
            'changelog/2026-07-27_deviceA.json',
        ]);
        expect(result.headSha).toBe('new-head-sha');
    });

    it('returns diverged on 404 (base SHA not found)', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposCompareCommits.mockRejectedValue(notFoundError);

        const result = await adapter.compareCommits('invalid-sha');

        expect(result.status).toBe('diverged');
        expect(result.changedFiles).toEqual([]);
    });

    it('returns identical status when no changes', async () => {
        mockReposCompareCommits.mockResolvedValue({
            data: {
                status: 'identical',
                files: [],
                merge_base_commit: { sha: 'base-sha' },
            },
        });

        const result = await adapter.compareCommits('base-sha');

        expect(result.status).toBe('identical');
        expect(result.changedFiles).toEqual([]);
    });
});

// ─── getLatestCommitSha ──────────────────────────────────────────────────────

describe('GitHubApiAdapter — getLatestCommitSha', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('returns the latest commit SHA', async () => {
        mockReposListCommits.mockResolvedValue({
            data: [{ sha: 'latest-commit-sha' }],
        });

        const sha = await adapter.getLatestCommitSha();

        expect(sha).toBe('latest-commit-sha');
    });

    it('throws if no commits found', async () => {
        mockReposListCommits.mockResolvedValue({ data: [] });

        await expect(adapter.getLatestCommitSha()).rejects.toThrow('No commits found');
    });
});

// ─── listDirectory ──────────────────────────────────────────────────────────

describe('GitHubApiAdapter — listDirectory', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('returns filenames from a directory listing', async () => {
        mockReposGetContent.mockResolvedValue(
            makeDirResponse([
                { name: 'users.json', type: 'file' },
                { name: 'posts.json', type: 'file' },
                { name: 'subdir', type: 'dir' },
            ]),
        );

        const files = await adapter.listDirectory('collections');

        expect(files).toEqual(['users.json', 'posts.json']);
    });

    it('returns empty array on 404', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        const files = await adapter.listDirectory('nonexistent');

        expect(files).toEqual([]);
    });
});

// ─── uploadBinaryFile ───────────────────────────────────────────────────────

describe('GitHubApiAdapter — uploadBinaryFile', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 1000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('uploads a new binary file', async () => {
        const notFoundError = new Error('Not Found');
        (notFoundError as any).status = 404;
        mockReposGetContent.mockRejectedValue(notFoundError);

        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'binary-sha' } },
        });

        const sha = await adapter.uploadBinaryFile(
            'files/avatar.png',
            'aW1hZ2VkYXRh',
            'Upload avatar',
        );

        expect(sha).toBe('binary-sha');
    });

    it('updates an existing binary file using its SHA', async () => {
        mockReposGetContent.mockResolvedValue(makeFileResponse('', 'existing-binary-sha'));

        mockReposCreateOrUpdateFileContents.mockResolvedValue({
            data: { content: { sha: 'updated-binary-sha' } },
        });

        const sha = await adapter.uploadBinaryFile(
            'files/avatar.png',
            'bmV3ZGF0YQ==',
            'Update avatar',
        );

        expect(sha).toBe('updated-binary-sha');
        expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
            expect.objectContaining({
                sha: 'existing-binary-sha',
            }),
        );
    });
});

// ─── getRepoSize ────────────────────────────────────────────────────────────

describe('GitHubApiAdapter — getRepoSize', () => {
    let adapter: GitHubApiAdapter;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockReposGet.mockResolvedValue({ data: { size: 5000 } });
        adapter = createAdapter();
        await adapter.init('ghp_token');
    });

    it('returns repo size in KB', async () => {
        mockReposGet.mockResolvedValue({ data: { size: 7500 } });

        const size = await adapter.getRepoSize();

        expect(size).toBe(7500);
    });
});

// ─── ensureInitialized ──────────────────────────────────────────────────────

describe('GitHubApiAdapter — ensureInitialized', () => {
    it('throws if init was not called', async () => {
        const adapter = createAdapter();

        await expect(adapter.fetchJsonFile('test.json')).rejects.toThrow('not initialized');
    });
});

// ─── Property accessors ─────────────────────────────────────────────────────

describe('GitHubApiAdapter — property accessors', () => {
    it('exposes config properties', () => {
        const adapter = createAdapter({
            owner: 'myuser',
            repo: 'myrepo',
            branch: 'develop',
            compactionThreshold: 50,
        });

        expect(adapter.owner).toBe('myuser');
        expect(adapter.repo).toBe('myrepo');
        expect(adapter.branch).toBe('develop');
        expect(adapter.compactionThreshold).toBe(50);
    });

    it('uses default values for optional config', () => {
        const adapter = createAdapter({ owner: 'user', repo: 'repo' });

        expect(adapter.branch).toBe('main');
        expect(adapter.compactionThreshold).toBe(20);
    });
});
