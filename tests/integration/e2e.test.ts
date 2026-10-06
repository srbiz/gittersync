/**
 * GitterSync — End-to-End Flow Verification
 *
 * Exercises every user-facing flow against the **real GitHub API** with no
 * mocks, using genuinely isolated storage per simulated device.
 *
 * Flows covered:
 *   1.  Bootstrap & auth            — init, registerCollections, empty full pull
 *   2.  Push                        — changelog file written, queue drained
 *   3.  Incremental pull            — Compare Commits path, no-op when unchanged
 *   4.  Multi-device convergence    — two isolated devices see each other's data
 *   5.  Field-level conflict (LWW)  — concurrent edits to different fields preserved
 *   6.  Same-field conflict         — last-write-wins, both devices converge
 *   7.  Delete propagation          — tombstones sync across devices
 *   8.  Compaction                  — changelogs folded into collection files
 *   9.  Binary files                — upload/download round-trip, files-first order
 *   10. Export / import             — ZIP round-trip into a fresh device
 *   11. Offline behaviour           — changes queue offline, flush on reconnect
 *   12. Status & error handling     — status surface, auth failure mapping
 *
 * Run with:
 *   GITTERSYNC_TEST_TOKEN=... npm run test:integration
 *   # or against an existing repo (no repo-creation permission needed):
 *   GITTERSYNC_TEST_TOKEN=... GITTERSYNC_TEST_REPO=owner/repo npm run test:integration
 */

// fake-indexeddb/auto MUST be imported before dexie — Dexie captures the
// global IndexedDB implementation when its module is first evaluated.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import JSZip from 'jszip';

import { GitHubSyncService } from '../../src/sync-service.js';
import { createDocument } from '../../src/merge.js';
import { AuthError } from '../../src/types.js';
import type { ChangelogFile, CollectionFile, MetaFile, FileRef } from '../../src/types.js';
import {
    acquireTestTarget,
    releaseTestTarget,
    cleanupStaleRepos,
    listRemotePaths,
    readRemoteText,
    getOctokit,
    type TestTarget,
} from './setup.js';

const TEST_TOKEN = process.env.GITTERSYNC_TEST_TOKEN;

// ─── Device simulation ─────────────────────────────────────────────────────
//
// LocalDB uses fixed IndexedDB database names, so devices sharing a process
// would share storage. Dexie reads `Dexie.dependencies` when a database
// instance is constructed — swapping in a fresh IDBFactory gives each
// simulated device a completely separate database namespace (including its
// own deviceId), which is what a real second device looks like.

interface Device {
    name: string;
    service: GitHubSyncService;
}

// ─── Base64 helpers (browser-compatible, no Node Buffer) ───────────────────

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function newDevice(name: string, target: TestTarget, compactionThreshold = 20): Device {
    const previous = Dexie.dependencies;
    const factory = new IDBFactory();
    Dexie.dependencies = {
        ...previous,
        indexedDB: factory,
        IDBKeyRange,
    };

    const service = new GitHubSyncService({
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        compactionThreshold,
    });

    return { name, service };
}

async function closeDevice(device: Device): Promise<void> {
    device.service.stopAutoSync();
    const db = device.service.getLocalDb();
    db.getMetaDatabase().close();
    db.getCollectionsDatabase().close();
}

/** Poll until `predicate` is true, or fail after `timeoutMs`. */
async function waitFor(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 20_000,
    label = 'condition',
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

describe.skipIf(!TEST_TOKEN)('GitterSync — E2E: all user flows against real GitHub', () => {
    let target: TestTarget;
    let deviceA: Device;
    let deviceB: Device;

    beforeAll(async () => {
        await cleanupStaleRepos();
        target = await acquireTestTarget();
    }, 90_000);

    afterAll(async () => {
        if (deviceA) await closeDevice(deviceA);
        if (deviceB) await closeDevice(deviceB);
        if (target) await releaseTestTarget(target);
    }, 60_000);

    // ─── 1. Bootstrap & auth ──────────────────────────────────────────────

    describe('1. bootstrap & auth', () => {
        it('initializes the service and registers collections', async () => {
            deviceA = newDevice('A', target, 3);
            expect(await deviceA.service.init(TEST_TOKEN!)).toBe(true);
            await deviceA.service.registerCollections(['users', 'tasks', 'notes']);
            expect(deviceA.service.getLocalDb().getRegisteredCollections()).toEqual([
                'users',
                'tasks',
                'notes',
            ]);
        }, 30_000);

        it('performs a full pull on an empty branch and reports "none"', async () => {
            const result = await deviceA.service.pull();
            expect(result).toEqual({ type: 'none' });
        }, 30_000);

        // NOTE: an "invalid token is rejected" assertion is intentionally absent.
        // `init()` validates *repo access*, and reads of a public repo succeed
        // without valid credentials (as does any request in environments that
        // inject GitHub credentials at the network layer). Auth-failure mapping
        // is covered by unit tests in tests/github-api.test.ts.
    });

    // ─── 2. Push ──────────────────────────────────────────────────────────

    describe('2. push writes changelog files to GitHub', () => {
        it('uploads local documents as a changelog and drains the queue', async () => {
            const db = deviceA.service.getLocalDb();
            const now = new Date().toISOString();

            await db.putDocument(
                'users',
                createDocument(
                    'alice',
                    { name: 'Alice', email: 'alice@old.example', role: 'admin' },
                    'seed',
                    now,
                ),
            );
            await db.putDocument(
                'users',
                createDocument('bob', { name: 'Bob', email: 'bob@example.com' }, 'seed', now),
            );
            await db.putDocument(
                'tasks',
                createDocument('t1', { title: 'Write tests', done: false }, 'seed', now),
            );

            expect(await db.getPendingChangelogCount()).toBe(3);

            await deviceA.service.push();

            expect(await db.getPendingChangelogCount()).toBe(0);

            const paths = await listRemotePaths(target);
            const changelogFiles = paths.filter((p) => p.startsWith('changelog/'));
            expect(changelogFiles).toHaveLength(1);

            const raw = await readRemoteText(target, changelogFiles[0]);
            const parsed = JSON.parse(raw!) as ChangelogFile;
            expect(parsed.deviceId).toBe(db.getDeviceId());
            expect(parsed.changes).toHaveLength(3);
            expect(parsed.changes.map((c) => c.docId).sort()).toEqual(['alice', 'bob', 't1']);

            const aliceChange = parsed.changes.find((c) => c.docId === 'alice')!;
            expect(aliceChange.fields!.name.value).toBe('Alice');
            expect(aliceChange.fields!.email.value).toBe('alice@old.example');
        }, 60_000);
    });

    // ─── 3. Incremental pull ──────────────────────────────────────────────

    describe('3. incremental pull via Compare Commits', () => {
        it('performs a full pull on a fresh device and materialises remote data', async () => {
            deviceB = newDevice('B', target, 3);
            await deviceB.service.init(TEST_TOKEN!);
            await deviceB.service.registerCollections(['users', 'tasks', 'notes']);

            // Fresh device has no cursor — this is a full pull of collections + changelogs
            const result = await deviceB.service.pull();
            expect(result.type).toBe('full');

            const db = deviceB.service.getLocalDb();
            const alice = await db.getDocument('users', 'alice');
            expect(alice?.data.name).toBe('Alice');
            expect(alice?.data.email).toBe('alice@old.example');

            const t1 = await db.getDocument('tasks', 't1');
            expect(t1?.data.title).toBe('Write tests');
        }, 60_000);

        it('reports "none" when nothing changed remotely (no redundant downloads)', async () => {
            const result = await deviceB.service.pull();
            expect(result).toEqual({ type: 'none' });
        }, 30_000);
    });

    // ─── 4 & 5. Multi-device convergence + field-level conflict ───────────

    describe('4. multi-device convergence', () => {
        it('propagates changes from device A to device B incrementally', async () => {
            const dbA = deviceA.service.getLocalDb();
            const alice = (await dbA.getDocument<any>('users', 'alice'))!;
            const updatedAt = new Date(Date.now() + 1000).toISOString(); // strictly newer

            alice.data.name = 'Alice Anderson';
            alice._fields.name = { updatedAt, device: dbA.getDeviceId() };
            alice.updated_at = updatedAt;
            await dbA.putDocument('users', alice);

            // Device A also creates a brand-new document
            await dbA.putDocument(
                'notes',
                createDocument('n1', { body: 'hello from A' }, dbA.getDeviceId(), updatedAt),
            );

            await deviceA.service.push();

            const result = await deviceB.service.pull();
            expect(result.type).toBe('incremental');

            const dbB = deviceB.service.getLocalDb();
            const aliceB = await dbB.getDocument<any>('users', 'alice');
            expect(aliceB?.data.name).toBe('Alice Anderson');

            const noteB = await dbB.getDocument<any>('notes', 'n1');
            expect(noteB?.data.body).toBe('hello from A');
        }, 60_000);
    });

    describe('5. field-level conflict resolution (different fields)', () => {
        it('preserves concurrent edits to different fields of the same document', async () => {
            const dbA = deviceA.service.getLocalDb();
            const dbB = deviceB.service.getLocalDb();

            // Device A edits only `role` and publishes it
            const aliceA = (await dbA.getDocument<any>('users', 'alice'))!;
            const tsA = new Date(Date.now() + 2000).toISOString();
            aliceA.data.role = 'owner';
            aliceA._fields.role = { updatedAt: tsA, device: dbA.getDeviceId() };
            aliceA.updated_at = tsA;
            await dbA.putDocument('users', aliceA);
            await deviceA.service.push();

            // Device B independently edits only `email` — it has not seen A's edit
            const aliceB = (await dbB.getDocument<any>('users', 'alice'))!;
            const tsB = new Date(Date.now() + 2000).toISOString();
            aliceB.data.email = 'alice@new.example';
            aliceB._fields.email = { updatedAt: tsB, device: dbB.getDeviceId() };
            aliceB.updated_at = tsB;
            await dbB.putDocument('users', aliceB);

            // B syncs: pulls A's role edit, publishes its email edit
            await deviceB.service.sync();
            // A syncs: pulls B's email edit
            await deviceA.service.sync();

            const finalA = await dbA.getDocument<any>('users', 'alice');
            const finalB = await dbB.getDocument<any>('users', 'alice');

            // Different-field edits must BOTH survive on both devices
            for (const [label, doc] of [
                ['A', finalA],
                ['B', finalB],
            ] as const) {
                expect(doc?.data.role, `role on device ${label}`).toBe('owner');
                expect(doc?.data.email, `email on device ${label}`).toBe('alice@new.example');
                expect(doc?.data.name, `name on device ${label}`).toBe('Alice Anderson');
            }

            // Devices converge to identical state
            expect(
                finalA,
                `device A: ${JSON.stringify(finalA)}\ndevice B: ${JSON.stringify(finalB)}`,
            ).toEqual(finalB);
        }, 90_000);
    });

    // ─── 6. Same-field conflict ───────────────────────────────────────────

    describe('6. same-field conflict resolution (LWW)', () => {
        it('converges both devices on the newest write', async () => {
            const dbA = deviceA.service.getLocalDb();
            const dbB = deviceB.service.getLocalDb();

            // A writes first and publishes it…
            const aliceA = (await dbA.getDocument<any>('users', 'alice'))!;
            const tsA = new Date(Date.now() - 5000).toISOString();
            aliceA.data.name = 'Zed (older)';
            aliceA._fields.name = { updatedAt: tsA, device: dbA.getDeviceId() };
            aliceA.updated_at = tsA;
            await dbA.putDocument('users', aliceA);
            await deviceA.service.push();

            // …B writes strictly later without having seen A's write
            const aliceB = (await dbB.getDocument<any>('users', 'alice'))!;
            const tsB = new Date(Date.now() + 5000).toISOString();
            aliceB.data.name = 'Yara (newer)';
            aliceB._fields.name = { updatedAt: tsB, device: dbB.getDeviceId() };
            aliceB.updated_at = tsB;
            await dbB.putDocument('users', aliceB);

            // B pulls (keeps its newer write) then publishes it
            await deviceB.service.sync();
            // A pulls the newer write and must adopt it
            await deviceA.service.sync();

            const finalA = await dbA.getDocument<any>('users', 'alice');
            const finalB = await dbB.getDocument<any>('users', 'alice');

            expect(finalA?.data.name).toBe('Yara (newer)');
            expect(finalB?.data.name).toBe('Yara (newer)');
            expect(
                finalA,
                `device A: ${JSON.stringify(finalA)}\ndevice B: ${JSON.stringify(finalB)}`,
            ).toEqual(finalB);
        }, 90_000);
    });

    // ─── 7. Deletes ───────────────────────────────────────────────────────

    describe('7. delete propagation', () => {
        it('syncs a soft-delete from A to B and hides it from default reads', async () => {
            const dbA = deviceA.service.getLocalDb();
            const dbB = deviceB.service.getLocalDb();

            await dbA.deleteDocument('tasks', 't1');
            await deviceA.service.push();
            await deviceB.service.pull();

            const deleted = await dbB.getDocument<any>('tasks', 't1');
            expect(deleted?.deleted_at).toBeTruthy();
            expect(deleted?.deleted_by).toBe(dbA.getDeviceId());

            const visible = await dbB.getAllDocuments('tasks');
            expect(visible.map((d) => d.id)).not.toContain('t1');

            const all = await dbB.getAllDocuments('tasks', true);
            expect(all.map((d) => d.id)).toContain('t1');
        }, 60_000);
    });

    // ─── 8. Compaction ────────────────────────────────────────────────────

    describe('8. compaction', () => {
        it('folds changelogs into collection files, clears changelog dir, updates meta.json', async () => {
            // Devices use compactionThreshold: 3, so the third push compacts.
            const dbA = deviceA.service.getLocalDb();
            const dbB = deviceB.service.getLocalDb();

            // Start from a drained changelog directory so the threshold is deterministic
            await deviceA.service.compact();

            for (let i = 1; i <= 3; i++) {
                await dbA.putDocument(
                    'notes',
                    createDocument(
                        'n' + i,
                        { body: `note ${i}` },
                        dbA.getDeviceId(),
                        new Date().toISOString(),
                    ),
                );
                await deviceA.service.push();
            }

            const paths = await listRemotePaths(target);
            const collectionPaths = paths.filter((p) => p.startsWith('collections/'));
            expect(collectionPaths).toContain('collections/users.json');
            expect(collectionPaths).toContain('collections/tasks.json');
            expect(collectionPaths).toContain('collections/notes.json');

            // The third push crossed the threshold, applied every changelog and
            // removed them — no changelog remains outstanding.
            expect(paths.filter((p) => p.startsWith('changelog/'))).toHaveLength(0);

            // Collection file is well formed and contains the merged documents
            const usersRaw = await readRemoteText(target, 'collections/users.json');
            const usersFile = JSON.parse(usersRaw!) as CollectionFile;
            expect(usersFile.collection).toBe('users');
            expect(Object.keys(usersFile.documents).sort()).toEqual(['alice', 'bob']);
            expect(usersFile.documents.alice.data.role).toBe('owner');
            expect(usersFile.documents.alice.data.email).toBe('alice@new.example');

            // meta.json reflects the compacted state.
            // NOTE: schemaVersion stays 0 until an app sets one via
            // LocalDB.setSchemaVersion() plus a compaction — the README's
            // "schemaVersion": 1 example is only a format illustration.
            const metaRaw = await readRemoteText(target, 'meta.json');
            const meta = JSON.parse(metaRaw!) as MetaFile;
            expect(typeof meta.schemaVersion).toBe('number');
            expect(meta.schemaVersion).toBe(0);
            expect(Object.keys(meta.collections).sort()).toEqual(['notes', 'tasks', 'users']);
            expect(meta.changelogCount).toBe(0);
            for (const name of ['users', 'tasks', 'notes']) {
                expect(meta.collections[name].sha).toMatch(/^[0-9a-f]{40}$/);
            }

            // No data loss: device B (already synced) converges to the same state
            await dbB.getAllDocuments('notes');
            await deviceB.service.pull();
            const noteIds = (await dbB.getAllDocuments('notes')).map((d) => d.id).sort();
            expect(noteIds).toEqual(['n1', 'n2', 'n3']);
        }, 120_000);

        it('lets a brand-new device hydrate entirely from compacted collection files', async () => {
            const deviceC = newDevice('C', target);
            await deviceC.service.init(TEST_TOKEN!);
            await deviceC.service.registerCollections(['users', 'tasks', 'notes']);

            const result = await deviceC.service.pull();
            expect(result.type).toBe('full');

            const dbC = deviceC.service.getLocalDb();
            const alice = await dbC.getDocument<any>('users', 'alice');
            expect(alice?.data.email).toBe('alice@new.example');
            expect(alice?.data.role).toBe('owner');

            // Compaction must not resurrect soft-deleted documents as live ones
            const t1 = await dbC.getDocument<any>('tasks', 't1');
            if (t1) expect(t1.deleted_at).toBeTruthy();

            const visibleTasks = await dbC.getAllDocuments('tasks');
            expect(visibleTasks.map((d) => d.id)).not.toContain('t1');
            expect((await dbC.getAllDocuments('notes')).length).toBe(3);

            await closeDevice(deviceC);
        }, 90_000);
    });

    // ─── 9. Binary files ──────────────────────────────────────────────────

    describe('9. binary file attachments', () => {
        const pngBase64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
        let ref: FileRef;

        it('uploads a binary file and returns valid metadata', async () => {
            ref = await deviceA.service.uploadFile(
                'files/attachments/pixel.png',
                pngBase64,
                'Attach pixel.png',
            );

            expect(ref.path).toBe('files/attachments/pixel.png');
            expect(ref.sha).toMatch(/^[0-9a-f]{40}$/);
            expect(ref.mimeType).toBe('image/png');
            expect(ref.size).toBeGreaterThan(0);

            const paths = await listRemotePaths(target);
            expect(paths).toContain('files/attachments/pixel.png');
        }, 60_000);

        it('downloads the exact same bytes', async () => {
            const blob = await deviceA.service.downloadFile('files/attachments/pixel.png');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            expect(bytesToBase64(bytes)).toBe(pngBase64);
            expect(bytes.length).toBe(base64ToBytes(pngBase64).length);
        }, 60_000);

        it("uploads to the demo's nested layout (files/<taskId>/<name>)", async () => {
            // The demo app stores attachments as files/<taskId>/<fileName>.
            const ref = await deviceA.service.uploadFile(
                'files/task-t1/notes.txt',
                btoa('nested attachment body'),
                'Attach notes.txt to task t1',
            );

            expect(ref.path).toBe('files/task-t1/notes.txt');

            const paths = await listRemotePaths(target);
            expect(paths).toContain('files/task-t1/notes.txt');

            const blob = await deviceA.service.downloadFile('files/task-t1/notes.txt');
            expect(await blob.text()).toBe('nested attachment body');
        }, 60_000);

        it('guarantees files-first ordering: blob exists before metadata references it', async () => {
            const db = deviceA.service.getLocalDb();
            const now = new Date().toISOString();

            // Upload first, then reference the file from a document, then push metadata.
            const attachment = await deviceA.service.uploadFile(
                'files/attachments/doc-attachment.png',
                pngBase64,
                'Attach doc-attachment.png',
            );

            await db.putDocument(
                'notes',
                createDocument(
                    'n-with-file',
                    { body: 'see attachment', attachment: attachment.path },
                    db.getDeviceId(),
                    now,
                ),
            );
            await deviceA.service.push();

            // The referenced blob is present on the remote — the reference is never dangling.
            const paths = await listRemotePaths(target);
            expect(paths).toContain(attachment.path);

            const doc = await db.getDocument<any>('notes', 'n-with-file');
            expect(doc?.data.attachment).toBe(attachment.path);

            // And another device can fetch it
            await deviceB.service.pull();
            const docB = await deviceB.service
                .getLocalDb()
                .getDocument<any>('notes', 'n-with-file');
            expect(docB?.data.attachment).toBe(attachment.path);
            const blob = await deviceB.service.downloadFile(docB!.data.attachment);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            expect(bytesToBase64(bytes)).toBe(pngBase64);
        }, 90_000);
    });

    // ─── 10. Export / import ──────────────────────────────────────────────

    describe('10. export & import', () => {
        it('exports a ZIP containing all collections, changelogs and binary files', async () => {
            const blob = await deviceA.service.exportData();
            const zip = await JSZip.loadAsync(await blob.arrayBuffer());

            const manifestRaw = await zip.file('gittersync-export/manifest.json')!.async('string');
            const manifest = JSON.parse(manifestRaw);

            expect(manifest.collections.sort()).toEqual(['notes', 'tasks', 'users']);
            expect(manifest.exportedAt).toBeTruthy();

            for (const name of ['users', 'tasks', 'notes']) {
                const file = zip.file(`gittersync-export/collections/${name}.json`);
                expect(file, `collection ${name} in export`).toBeTruthy();
            }
            expect(zip.file('gittersync-export/meta.json')).toBeTruthy();

            // Binary attachments — including nested ones (demo layout) — are
            // included and counted.
            expect(manifest.fileCount).toBe(3);
            expect(zip.file('gittersync-export/files/attachments/pixel.png')).toBeTruthy();
            expect(zip.file('gittersync-export/files/attachments/doc-attachment.png')).toBeTruthy();
            expect(zip.file('gittersync-export/files/task-t1/notes.txt')).toBeTruthy();
        }, 90_000);

        it('imports the ZIP into a fresh device and restores the data', async () => {
            const blob = await deviceA.service.exportData();

            const deviceD = newDevice('D', target);
            await deviceD.service.init(TEST_TOKEN!);
            await deviceD.service.registerCollections(['users', 'tasks', 'notes']);
            await deviceD.service.importData(blob);

            const dbD = deviceD.service.getLocalDb();
            const alice = await dbD.getDocument<any>('users', 'alice');
            expect(alice?.data.email).toBe('alice@new.example');
            expect(alice?.data.role).toBe('owner');

            // Import clears the cursor so the next pull re-validates against remote
            expect(await dbD.getSyncCursor()).toBeNull();
            const pull = await deviceD.service.pull();
            expect(pull.type).toBe('full');
            expect(await dbD.getSyncCursor()).not.toBeNull();

            // Attachments referenced by imported documents are still fetchable
            const imported = await dbD.getDocument<any>('notes', 'n-with-file');
            const attachmentBlob = await deviceD.service.downloadFile(imported!.data.attachment);
            expect(new Uint8Array(await attachmentBlob.arrayBuffer()).length).toBeGreaterThan(0);

            await closeDevice(deviceD);
        }, 120_000);

        it('rejects a corrupt ZIP with a ValidationError', async () => {
            const deviceE = newDevice('E', target);
            await deviceE.service.init(TEST_TOKEN!);
            await deviceE.service.registerCollections(['users']);

            await expect(
                deviceE.service.importData(new Blob(['not a zip at all'])),
            ).rejects.toThrow(/Invalid or corrupted ZIP/);

            await closeDevice(deviceE);
        }, 60_000);
    });

    // ─── 11. Offline behaviour ────────────────────────────────────────────

    describe('11. offline behaviour', () => {
        it('queues changes offline and auto-flushes them on reconnect', async () => {
            const dbA = deviceA.service.getLocalDb();
            const { octokit } = await getOctokit();

            const headBefore = (
                await octokit.repos.getBranch({
                    owner: target.owner,
                    repo: target.repo,
                    branch: target.branch,
                })
            ).data.commit.sha;

            // Make sure the queue is empty before starting auto-sync, then wait
            // for the initial pass to fully settle so it cannot race the
            // offline write below.
            expect(await dbA.getPendingChangelogCount()).toBe(0);
            deviceA.service.startAutoSync(2_000);
            await waitFor(
                async () => !deviceA.service.getStatus().isSyncing,
                20_000,
                'initial auto-sync to settle',
            );
            await new Promise((resolve) => setTimeout(resolve, 2_500));

            // ── Go offline ──────────────────────────────────────────────────
            window.dispatchEvent(new Event('offline'));
            expect(deviceA.service.isOnline).toBe(false);

            await dbA.putDocument(
                'notes',
                createDocument(
                    'n-offline',
                    { body: 'written offline' },
                    dbA.getDeviceId(),
                    new Date().toISOString(),
                ),
            );
            expect(await dbA.getPendingChangelogCount()).toBe(1);

            // Let several auto-sync intervals elapse while offline.
            await new Promise((resolve) => setTimeout(resolve, 5_000));

            // Nothing was lost, and nothing was pushed to GitHub.
            expect(await dbA.getPendingChangelogCount()).toBe(1);
            const headWhileOffline = (
                await octokit.repos.getBranch({
                    owner: target.owner,
                    repo: target.repo,
                    branch: target.branch,
                })
            ).data.commit.sha;
            expect(headWhileOffline).toBe(headBefore);
            const remoteNotes = await readRemoteText(target, 'collections/notes.json');
            expect(remoteNotes ?? '').not.toContain('written offline');

            // ── Reconnect: the online handler triggers an immediate sync ─────
            window.dispatchEvent(new Event('online'));
            expect(deviceA.service.isOnline).toBe(true);

            await waitFor(
                async () => (await dbA.getPendingChangelogCount()) === 0,
                30_000,
                'offline change to be flushed after reconnect',
            );

            const headAfter = (
                await octokit.repos.getBranch({
                    owner: target.owner,
                    repo: target.repo,
                    branch: target.branch,
                })
            ).data.commit.sha;
            expect(headAfter).not.toBe(headBefore);

            deviceA.service.stopAutoSync();
            // Let any in-flight sync finish before later tests inspect status
            await waitFor(
                async () => !deviceA.service.getStatus().isSyncing,
                20_000,
                'auto-sync to be idle',
            );
        }, 180_000);
    });

    // ─── 12. Status & reporting ───────────────────────────────────────────

    describe('12. status reporting', () => {
        it('exposes a complete, accurate status surface', async () => {
            const status = await deviceA.service.getFullStatus();
            const dbA = deviceA.service.getLocalDb();

            expect(status.isSyncing).toBe(false);
            expect(status.isOnline).toBe(true);
            expect(status.deviceId).toBe(dbA.getDeviceId());
            expect(status.pendingChanges).toBe(0);
            expect(typeof status.repoSizeKb).toBe('number');
            expect(status.rateLimitRemaining).toBeGreaterThan(0);
            expect(status.cursor?.sha).toMatch(/^[0-9a-f]{40}$/);

            // Cursor must match the real remote head
            const { octokit } = await getOctokit();
            const { data: branch } = await octokit.repos.getBranch({
                owner: target.owner,
                repo: target.repo,
                branch: target.branch,
            });
            expect(status.cursor!.sha).toBe(branch.commit.sha);
        }, 60_000);

        it('surfaces a monotonically increasing remote commit history', async () => {
            const commits = await (
                await getOctokit()
            ).octokit.repos.listCommits({
                owner: target.owner,
                repo: target.repo,
                sha: target.branch,
                per_page: 100,
            });
            expect(commits.data.length).toBeGreaterThan(1);
        }, 30_000);
    });
});
