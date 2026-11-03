/**
 * @vitest-environment jsdom
 */

/**
 * GitterSync — LocalDB schema lifecycle & convenience API tests
 *
 * Covers the cases that a dynamic IndexedDB schema gets wrong easily:
 * registering a collection after the database is open, re-opening in a later
 * session (a page reload), and never losing tables created previously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { LocalDB } from '../src/local-db';
import { ValidationError } from '../src/types';
import type { SyncedDocument } from '../src/types';

const DB_NAMES = ['gittersync', 'gittersync_collections'];

async function deleteDatabase(name: string): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

async function cleanup(): Promise<void> {
    for (const name of DB_NAMES) await deleteDatabase(name);
}

function nativeVersion(name: string): Promise<{ version: number; stores: string[] }> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
            const db = req.result;
            const snapshot = { version: db.version, stores: Array.from(db.objectStoreNames) };
            db.close();
            resolve(snapshot);
        };
        req.onerror = () => reject(req.error);
    });
}

afterEach(async () => {
    await cleanup();
});

// ─── Schema lifecycle ──────────────────────────────────────────────────────

describe('LocalDB — dynamic schema', () => {
    let db: LocalDB;

    beforeEach(async () => {
        await cleanup();
        db = new LocalDB();
        await db.init();
    });

    afterEach(async () => {
        await db.close();
    });

    it('registers a collection after the database has already been opened', async () => {
        await db.registerCollection('alpha');
        await db.create('alpha', 'a1', { n: 1 });
        expect((await db.getAllDocuments('alpha')).length).toBe(1);

        // The collections database is open at this point — this used to throw
        // "Cannot add version when database is open".
        await db.registerCollection('beta');
        await db.create('beta', 'b1', { n: 2 });

        expect((await db.getAllDocuments('beta')).length).toBe(1);
        expect((await db.getAllDocuments('alpha')).length).toBe(1);
    });

    it('keeps every previously created table visible in a later session', async () => {
        // Session 1: four collections
        for (const name of ['a', 'b', 'c', 'd']) {
            await db.registerCollection(name);
            await db.create(name, `${name}1`, { name });
        }
        const before = await nativeVersion('gittersync_collections');
        expect(before.stores.sort()).toEqual(['col_a', 'col_b', 'col_c', 'col_d']);
        await db.close();

        // Session 2 (page reload): register only a subset plus a new one
        const reloaded = new LocalDB();
        await reloaded.init();
        await reloaded.registerCollection('a');

        // Data written in the previous session is still readable
        const docs = await reloaded.getAllDocuments<{ name: string }>('a');
        expect(docs).toHaveLength(1);
        expect(docs[0].data.name).toBe('a');

        // The other tables were not dropped from the schema
        expect(await reloaded.getAllDocuments('d')).toHaveLength(1);

        // A brand-new collection can still be added on top
        await reloaded.registerCollection('e');
        await reloaded.create('e', 'e1', { name: 'e' });
        expect(await reloaded.getAllDocuments('e')).toHaveLength(1);
        expect(await reloaded.getAllDocuments('a')).toHaveLength(1);

        const after = await nativeVersion('gittersync_collections');
        expect(after.version).toBeGreaterThan(before.version);
        expect(after.stores.sort()).toEqual(['col_a', 'col_b', 'col_c', 'col_d', 'col_e']);

        await reloaded.close();
    });

    it('keeps the device ID stable across sessions', async () => {
        const first = db.getDeviceId();
        await db.close();

        const reloaded = new LocalDB();
        await reloaded.init();
        expect(reloaded.getDeviceId()).toBe(first);
        await reloaded.close();
    });

    it('rejects collection names that cannot be tables or files', async () => {
        await expect(db.registerCollection('users/tasks')).rejects.toThrow(ValidationError);
        await expect(db.registerCollection('')).rejects.toThrow(ValidationError);
    });

    it('reports registration state', async () => {
        expect(db.isCollectionRegistered('alpha')).toBe(false);
        await db.registerCollection('alpha');
        expect(db.isCollectionRegistered('alpha')).toBe(true);
        expect(db.getRegisteredCollections()).toContain('alpha');
    });

    it('gives a helpful error for an unregistered collection', async () => {
        await expect(db.getAllDocuments('nope')).rejects.toThrow(/not registered/);
    });
});

// ─── Convenience API ───────────────────────────────────────────────────────

describe('LocalDB — document helpers', () => {
    let db: LocalDB;

    beforeEach(async () => {
        await cleanup();
        db = new LocalDB();
        await db.init();
        await db.registerCollection('tasks');
    });

    afterEach(async () => {
        await db.close();
    });

    it('creates a document from plain data with field metadata', async () => {
        const doc = await db.create<{ title: string; done: boolean }>('tasks', 't1', {
            title: 'Write docs',
            done: false,
        });

        expect(doc.id).toBe('t1');
        expect(doc.created_at).toBeTruthy();
        expect(doc.deleted_at).toBeNull();
        expect(Object.keys(doc._fields).sort()).toEqual(['done', 'title']);
        expect(doc._fields.title.device).toBe(db.getDeviceId());

        // A create was queued for the next push
        const queued = await db.getPendingChangelogEntries();
        expect(queued).toHaveLength(1);
        expect(queued[0].op).toBe('create');
        expect(queued[0].fields?.title.value).toBe('Write docs');
    });

    it('refuses to create over an existing document', async () => {
        await db.create('tasks', 't1', { title: 'first' });
        await expect(db.create('tasks', 't1', { title: 'second' })).rejects.toThrow(
            ValidationError,
        );
    });

    it('patches only the touched fields', async () => {
        await db.create<{ title: string; done: boolean; position: number }>(
            'tasks',
            't1',
            { title: 'Write docs', done: false, position: 0 },
            '2026-07-01T00:00:00.000Z',
        );

        const older = (await db.getDocument('tasks', 't1'))!._fields.title.updatedAt;
        expect(older).toBe('2026-07-01T00:00:00.000Z');
        const updated = await db.updateFields<{ title: string; done: boolean; position: number }>(
            'tasks',
            't1',
            { done: true },
            '2026-08-01T00:00:00.000Z',
        );

        expect(updated!.data.done).toBe(true);
        expect(updated!.data.title).toBe('Write docs');
        // Only `done` moved forward — a concurrent title edit on another device
        // still wins on merge.
        expect(updated!._fields.done.updatedAt).toBe('2026-08-01T00:00:00.000Z');
        expect(updated!._fields.title.updatedAt).toBe(older);
        expect(updated!.updated_at).toBe('2026-08-01T00:00:00.000Z');
    });

    it('removes a field when it is set to undefined', async () => {
        await db.create<{ title: string; note?: string }>('tasks', 't1', {
            title: 'x',
            note: 'temp',
        });
        const updated = await db.updateFields<{ title: string; note?: string }>('tasks', 't1', {
            note: undefined,
        });

        expect(updated!.data.note).toBeUndefined();
        expect(updated!._fields.note).toBeUndefined();
        expect('note' in updated!.data).toBe(false);
    });

    it('returns null when patching a missing document', async () => {
        expect(await db.updateFields('tasks', 'missing', { title: 'x' })).toBeNull();
    });

    it('soft-deletes once and restores on demand', async () => {
        await db.create('tasks', 't1', { title: 'x' });

        expect(await db.deleteDocument('tasks', 't1')).toBe(true);
        // Idempotent: a second delete does not queue another entry
        expect(await db.deleteDocument('tasks', 't1')).toBe(false);
        expect(await db.getAllDocuments('tasks')).toHaveLength(0);
        expect(await db.getAllDocuments('tasks', true)).toHaveLength(1);

        const restored = await db.restoreDocument('tasks', 't1');
        expect(restored!.deleted_at).toBeNull();
        expect(await db.getAllDocuments('tasks')).toHaveLength(1);

        const ops = (await db.getPendingChangelogEntries()).map((e) => e.op);
        expect(ops).toEqual(['create', 'delete', 'update']);
    });

    it('filters documents with queryDocuments', async () => {
        await db.create<{ done: boolean }>('tasks', 't1', { done: true });
        await db.create<{ done: boolean }>('tasks', 't2', { done: false });

        const open = await db.queryDocuments<{ done: boolean }>('tasks', (data) => !data.done);
        expect(open.map((d) => d.id)).toEqual(['t2']);
    });

    it('counts documents with and without tombstones', async () => {
        await db.create('tasks', 't1', {});
        await db.create('tasks', 't2', {});
        await db.deleteDocument('tasks', 't2');

        expect(await db.getDocumentCount('tasks')).toBe(1);
        expect(await db.getDocumentCount('tasks', true)).toBe(2);
    });

    it('keeps queued entries in FIFO order even within one millisecond', async () => {
        const now = '2026-08-01T00:00:00.000Z';
        await db.queueChangelogEntry({
            collection: 'tasks',
            docId: 't1',
            op: 'create',
            fields: { title: { value: 'a', updatedAt: now } },
        });
        await db.queueChangelogEntry({
            collection: 'tasks',
            docId: 't1',
            op: 'update',
            fields: { title: { value: 'b', updatedAt: now } },
        });
        // Force identical queuedAt values
        const table = db.getMetaDatabase().changelog_queue;
        await table.toCollection().modify((entry) => {
            entry.queuedAt = now;
        });

        const entries = await db.getPendingChangelogEntries();
        expect(entries.map((e) => e.op)).toEqual(['create', 'update']);
    });

    it('includes data fields that are missing from _fields when queueing', async () => {
        const doc: SyncedDocument<{ a: number; b: number }> = {
            id: 't1',
            data: { a: 1, b: 2 },
            // `b` has no metadata — it must still reach GitHub
            _fields: { a: { updatedAt: '2026-08-01T00:00:00.000Z', device: 'deviceA' } },
            updated_at: '2026-08-01T00:00:00.000Z',
            created_at: '2026-08-01T00:00:00.000Z',
            deleted_at: null,
            deleted_by: null,
        };

        await db.putDocument('tasks', doc);

        const [entry] = await db.getPendingChangelogEntries();
        expect(Object.keys(entry.fields!).sort()).toEqual(['a', 'b']);
        expect(entry.fields!.b).toEqual({
            value: 2,
            updatedAt: '2026-08-01T00:00:00.000Z',
        });
    });
});

// ─── Bulk operations ───────────────────────────────────────────────────────

describe('LocalDB — bulk operations', () => {
    let db: LocalDB;

    beforeEach(async () => {
        await cleanup();
        db = new LocalDB();
        await db.init();
        await db.registerCollection('tasks');
    });

    afterEach(async () => {
        await db.close();
    });

    function doc(id: string, deleted = false): SyncedDocument {
        return {
            id,
            data: { id },
            _fields: {},
            updated_at: '2026-08-01T00:00:00.000Z',
            created_at: '2026-08-01T00:00:00.000Z',
            deleted_at: deleted ? '2026-08-02T00:00:00.000Z' : null,
            deleted_by: null,
        };
    }

    it('replaces a collection atomically', async () => {
        await db.create('tasks', 'old', {});
        const queuedBefore = await db.getPendingChangelogCount();

        await db.replaceCollection('tasks', { n1: doc('n1'), n2: doc('n2') });

        const docs = await db.getAllDocuments('tasks');
        expect(docs.map((d) => d.id).sort()).toEqual(['n1', 'n2']);
        // Remote data must not be echoed back into the outbound queue
        expect(await db.getPendingChangelogCount()).toBe(queuedBefore);
    });

    it('replaces a collection with an empty document set', async () => {
        await db.create('tasks', 'old', {});
        await db.replaceCollection('tasks', {});
        expect(await db.getAllDocuments('tasks')).toHaveLength(0);
    });

    it('merges remote documents and reports how many were written', async () => {
        await db.create('tasks', 'local', {});

        const written = await db.mergeDocuments(
            'tasks',
            { remote: doc('remote') },
            (local, remote) => remote,
        );

        expect(written).toBe(1);
        expect((await db.getAllDocuments('tasks')).map((d) => d.id).sort()).toEqual([
            'local',
            'remote',
        ]);
    });

    it('returns 0 when merging an empty document set', async () => {
        expect(await db.mergeDocuments('tasks', {}, (l) => l)).toBe(0);
    });

    it('clears a single collection without touching the queue', async () => {
        await db.create('tasks', 't1', {});
        await db.clearCollection('tasks');

        expect(await db.getAllDocuments('tasks')).toHaveLength(0);
        expect(await db.getPendingChangelogCount()).toBe(1);
    });

    it('wipes everything except the device ID on clearAll', async () => {
        const deviceId = db.getDeviceId();
        await db.create('tasks', 't1', {});
        await db.setSyncCursor({ sha: 'abc', timestamp: new Date().toISOString() });
        await db.setSchemaVersion(4);

        await db.clearAll();

        expect(await db.getAllDocuments('tasks')).toHaveLength(0);
        expect(await db.getPendingChangelogCount()).toBe(0);
        expect(await db.getSyncCursor()).toBeNull();
        expect(await db.getSchemaVersion()).toBe(0);
        expect(db.getDeviceId()).toBe(deviceId);
        expect(await db.getMetaValue('deviceId')).toBe(deviceId);
    });

    it('stores and reads arbitrary meta values', async () => {
        expect(await db.getMetaValue('lastBoard')).toBeNull();
        await db.setMetaValue('lastBoard', 'kanban');
        expect(await db.getMetaValue('lastBoard')).toBe('kanban');
    });

    it('recovers from a corrupt sync cursor', async () => {
        await db.setMetaValue('syncCursor', '{ not json');
        expect(await db.getSyncCursor()).toBeNull();
        // The corrupt value is removed so the next pull is a clean full pull
        expect(await db.getMetaValue('syncCursor')).toBeNull();
    });
});

// ─── Dexie interop ─────────────────────────────────────────────────────────

describe('LocalDB — Dexie interop', () => {
    it('exposes the underlying databases', async () => {
        await cleanup();
        const db = new LocalDB();
        await db.init();

        expect(db.getMetaDatabase()).toBeInstanceOf(Dexie);
        expect(db.getCollectionsDatabase()).toBeInstanceOf(Dexie);
        expect(db.getMetaDatabase().name).toBe('gittersync');
        expect(db.getCollectionsDatabase().name).toBe('gittersync_collections');

        await db.close();
    });
});
