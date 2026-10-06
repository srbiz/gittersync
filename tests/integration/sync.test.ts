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
import {
    acquireTestTarget,
    releaseTestTarget,
    cleanupStaleRepos,
    listRemotePaths,
    type TestTarget,
} from './setup.js';

const TEST_TOKEN = process.env.GITTERSYNC_TEST_TOKEN;

describe.skipIf(!TEST_TOKEN)('GitterSync — Integration: Full Sync Cycle', () => {
    let service: GitHubSyncService;
    let target: TestTarget;
    let repoOwner: string;
    let repoName: string;

    beforeAll(async () => {
        // Clean up any stale test repos from previous interrupted runs
        await cleanupStaleRepos();

        // Acquire an isolated target (temp repo, or scratch branch of an existing repo)
        target = await acquireTestTarget();
        repoOwner = target.owner;
        repoName = target.repo;

        service = new GitHubSyncService({
            owner: repoOwner,
            repo: repoName,
            branch: target.branch,
            compactionThreshold: 5,
        });
    }, 90_000);

    afterAll(async () => {
        service?.stopAutoSync();
        if (target) {
            await releaseTestTarget(target);
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
        // Empty branch returns a 'none' PullResult — nothing to pull
        expect(result.type).toBe('none');
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
        // push() already advanced the sync cursor to head, so this pull finds
        // nothing new to fetch on the same device (an incremental pull would
        // report 'incremental' on a device that is actually behind).
        expect(result.type).toBe('none');

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
        expect(['none', 'incremental', 'full']).toContain(result.type);

        // The queued task reached the remote as a changelog or a collection file
        const paths = await listRemotePaths(target);
        expect(paths.some((p) => p.startsWith('changelog/') || p.startsWith('collections/'))).toBe(
            true,
        );
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
            branch: target.branch,
            compactionThreshold: 5,
        });

        await service2.init(TEST_TOKEN!);
        await service2.registerCollections(['users', 'tasks']);

        // Device 2 pulls changes from Device 1
        const result = await service2.pull();
        expect(['none', 'incremental', 'full']).toContain(result.type);

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

        // Device 2's write reached the remote
        const device2Id = db2.getDeviceId();
        const paths = await listRemotePaths(target);
        expect(paths.some((p) => p.startsWith('changelog/') && p.includes(device2Id))).toBe(true);

        service2.stopAutoSync();
    }, 30_000);
});
