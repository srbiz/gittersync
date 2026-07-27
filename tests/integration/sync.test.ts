/**
 * GitterSync — Integration Tests: Full Sync Cycle
 *
 * These tests exercise the real GitHub API — no mocks.
 * They require the GITTERSYNC_TEST_TOKEN environment variable.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitHubSyncService } from '../../src/sync-service.js';
import { createDocument } from '../../src/merge.js';
import { createTempRepo, deleteTempRepo, cleanupStaleRepos } from './setup.js';

const TEST_TOKEN = process.env.GITTERSYNC_TEST_TOKEN;

describe.skipIf(!TEST_TOKEN)('GitterSync — Integration: Full Sync Cycle', () => {
    let service: GitHubSyncService;
    let repoOwner: string;
    let repoName: string;

    beforeAll(async () => {
        // Clean up any stale test repos from previous interrupted runs
        await cleanupStaleRepos();

        // Create a fresh test repo
        const repo = await createTempRepo();
        repoOwner = repo.owner;
        repoName = repo.repo;

        service = new GitHubSyncService({
            owner: repoOwner,
            repo: repoName,
            compactionThreshold: 5,
        });
    }, 60_000);

    afterAll(async () => {
        service?.stopAutoSync();
        if (repoOwner && repoName) {
            await deleteTempRepo(repoOwner, repoName);
        }
    }, 30_000);

    it('initializes with a valid token', async () => {
        const result = await service.init(TEST_TOKEN!);
        expect(result).toBe(true);
    }, 15_000);

    it('registers collections', async () => {
        await service.registerCollections(['users', 'tasks']);
    }, 10_000);

    it('performs an initial pull (empty repo)', async () => {
        const result = await service.pull();
        // Empty repo returns 'none' — nothing to pull
        expect(result).toBe('none');
    }, 15_000);

    it('pushes local changes to GitHub', async () => {
        const db = service.getLocalDb();
        const now = new Date().toISOString();
        await db.putDocument(
            'users',
            createDocument('u1', { name: 'Alice', email: 'alice@example.com' }, 'device-int', now),
        );
        await db.putDocument(
            'users',
            createDocument('u2', { name: 'Bob', email: 'bob@example.com' }, 'device-int', now),
        );

        await service.push();
    }, 15_000);

    it('pulls data back from GitHub', async () => {
        const result = await service.pull();
        // Should detect changes from the push
        expect(result).toBe('fast-forward');

        const db = service.getLocalDb();
        const u1 = await db.getDocument('users', 'u1');
        expect(u1).toBeDefined();
        expect(u1!.data.name).toBe('Alice');
    }, 15_000);

    it('syncs (pull then push)', async () => {
        const db = service.getLocalDb();
        const now = new Date().toISOString();
        await db.putDocument(
            'tasks',
            createDocument('t1', { title: 'Write tests', done: false }, 'device-int', now),
        );

        const result = await service.sync();
        expect(['fast-forward', 'none']).toContain(result);
    }, 15_000);

    it('reports sync status', async () => {
        const status = service.getStatus();

        expect(status.isSyncing).toBe(false);
        expect(status.isOnline).toBe(true);
        expect(status.deviceId).toBeDefined();
        expect(status.pendingChanges).toBe(0);
    }, 5_000);

    it('reports full status', async () => {
        const status = await service.getFullStatus();

        expect(status.isSyncing).toBe(false);
        expect(status.isOnline).toBe(true);
        expect(status.deviceId).toBeDefined();
        expect(status.repoSizeKb).toBeDefined();
    }, 10_000);

    it('compacts changelogs', async () => {
        // Push a few more changes to accumulate changelogs
        const db = service.getLocalDb();
        const now = new Date().toISOString();
        await db.putDocument(
            'tasks',
            createDocument('t2', { title: 'Review PR', done: false }, 'device-int', now),
        );
        await service.push();

        await db.putDocument(
            'tasks',
            createDocument('t3', { title: 'Deploy', done: false }, 'device-int', now),
        );
        await service.push();

        // Compact should merge changelogs into collection files
        await service.compact();
    }, 30_000);

    it('handles concurrent devices', async () => {
        // Simulate a second device by creating another service instance
        const service2 = new GitHubSyncService({
            owner: repoOwner,
            repo: repoName,
            compactionThreshold: 5,
        });

        await service2.init(TEST_TOKEN!);
        await service2.registerCollections(['users', 'tasks']);

        // Device 2 pulls changes from Device 1
        const result = await service2.pull();
        expect(['fast-forward', 'none']).toContain(result);

        // Device 2 makes its own changes
        const db2 = service2.getLocalDb();
        const now = new Date().toISOString();
        await db2.putDocument(
            'users',
            createDocument(
                'u3',
                { name: 'Charlie', email: 'charlie@example.com' },
                'device-int-2',
                now,
            ),
        );
        await service2.push();

        service2.stopAutoSync();
    }, 30_000);
});
