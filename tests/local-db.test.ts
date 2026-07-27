/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { LocalDB } from '../src/local-db';
import type { SyncedDocument } from '../src/types';

// ─── Database Cleanup ───────────────────────────────────────────────────────
// Dexie databases persist across tests in jsdom. We must delete them between tests.

async function cleanupDatabases(): Promise<void> {
    const dbs = ['gittersync', 'gittersync_collections'];
    for (const name of dbs) {
        await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        });
    }
}

// Clean up IndexedDB after every test to prevent data leakage
afterEach(async () => {
    await cleanupDatabases();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDoc(
    id: string,
    data: Record<string, unknown>,
    fields: Record<string, { updatedAt: string; device: string }>,
    overrides: Partial<SyncedDocument> = {},
): SyncedDocument {
    const allTimestamps = Object.values(fields).map((f) => new Date(f.updatedAt).getTime());
    const maxTs = allTimestamps.length > 0 ? Math.max(...allTimestamps) : Date.now();

    return {
        id,
        data,
        _fields: fields,
        updated_at: new Date(maxTs).toISOString(),
        created_at: '2026-07-01T00:00:00Z',
        deleted_at: null,
        deleted_by: null,
        ...overrides,
    };
}

// ─── Initialization ────────────────────────────────────────────────────────

describe('LocalDB — init', () => {
    let db: LocalDB;

    beforeEach(() => {
        db = new LocalDB();
    });

    it('generates a device ID on first init', async () => {
        const deviceId = await db.init();

        expect(deviceId).toBeTruthy();
        expect(typeof deviceId).toBe('string');
    });

    it('returns the same device ID on subsequent init calls', async () => {
        const id1 = await db.init();
        const id2 = db.getDeviceId();

        expect(id1).toBe(id2);
    });

    it('throws if getDeviceId is called before init', () => {
        expect(() => db.getDeviceId()).toThrow('LocalDB not initialized');
    });
});

// ─── Collection Management ─────────────────────────────────────────────────

describe('LocalDB — registerCollection', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
    });

    it('registers a collection', async () => {
        await db.registerCollection('users');

        expect(db.getRegisteredCollections()).toContain('users');
    });

    it('double-register is a no-op', async () => {
        await db.registerCollection('users');
        await db.registerCollection('users');

        expect(db.getRegisteredCollections().filter((c) => c === 'users')).toHaveLength(1);
    });

    it('registers multiple collections', async () => {
        await db.registerCollection('users');
        await db.registerCollection('posts');

        expect(db.getRegisteredCollections()).toContain('users');
        expect(db.getRegisteredCollections()).toContain('posts');
    });
});

// ─── Document CRUD ──────────────────────────────────────────────────────────

describe('LocalDB — createDocument / getDocument', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('creates and retrieves a document', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        await db.createDocument('users', doc);
        const retrieved = await db.getDocument('users', 'u1');

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe('u1');
        expect((retrieved!.data as any).name).toBe('Alice');
    });

    it('returns undefined for non-existent document', async () => {
        const result = await db.getDocument('users', 'nonexistent');
        expect(result).toBeUndefined();
    });
});

describe('LocalDB — putDocument', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('creates a document with put if it does not exist', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        await db.putDocument('users', doc);
        const retrieved = await db.getDocument('users', 'u1');

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe('u1');
    });

    it('updates an existing document with put', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', doc, false);

        const updated = makeDoc(
            'u1',
            { name: 'Bob' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', updated, false);

        const retrieved = await db.getDocument('users', 'u1');
        expect((retrieved!.data as any).name).toBe('Bob');
    });

    it('queues a changelog entry by default', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        await db.putDocument('users', doc);

        const pending = await db.getPendingChangelogEntries();
        expect(pending.length).toBeGreaterThan(0);
        expect(pending[0].docId).toBe('u1');
    });

    it('skips changelog entry when queueChangelog=false', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        await db.putDocument('users', doc, false);

        const pending = await db.getPendingChangelogEntries();
        expect(pending).toHaveLength(0);
    });
});

describe('LocalDB — deleteDocument', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('soft-deletes a document by setting deleted_at', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', doc, false);

        await db.deleteDocument('users', 'u1');

        const retrieved = await db.getDocument('users', 'u1');
        expect(retrieved!.deleted_at).not.toBeNull();
    });

    it('is a no-op for non-existent document', async () => {
        await expect(db.deleteDocument('users', 'nonexistent')).resolves.toBeUndefined();
    });

    it('queues a delete changelog entry', async () => {
        const doc = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', doc, false);

        await db.deleteDocument('users', 'u1');

        const pending = await db.getPendingChangelogEntries();
        const deleteEntry = pending.find((e) => e.op === 'delete');
        expect(deleteEntry).toBeDefined();
        expect(deleteEntry!.docId).toBe('u1');
        expect(deleteEntry!.deletedAt).toBeTruthy();
    });
});

describe('LocalDB — getAllDocuments', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('returns all non-deleted documents by default', async () => {
        const doc1 = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        const doc2 = makeDoc(
            'u2',
            { name: 'Bob' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        const doc3 = makeDoc(
            'u3',
            { name: 'Charlie' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            { deleted_at: '2026-07-28T10:00:00Z', deleted_by: 'deviceA' },
        );

        await db.putDocument('users', doc1, false);
        await db.putDocument('users', doc2, false);
        await db.putDocument('users', doc3, false);

        const docs = await db.getAllDocuments('users');
        expect(docs).toHaveLength(2);
        expect(docs.map((d) => d.id)).toEqual(expect.arrayContaining(['u1', 'u2']));
    });

    it('includes deleted documents when includeDeleted=true', async () => {
        const doc1 = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        const doc2 = makeDoc(
            'u2',
            { name: 'Bob' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            { deleted_at: '2026-07-28T10:00:00Z', deleted_by: 'deviceA' },
        );

        await db.putDocument('users', doc1, false);
        await db.putDocument('users', doc2, false);

        const docs = await db.getAllDocuments('users', true);
        expect(docs).toHaveLength(2);
    });

    it('returns documents as a map keyed by ID', async () => {
        const doc1 = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        const doc2 = makeDoc(
            'u2',
            { name: 'Bob' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        await db.putDocument('users', doc1, false);
        await db.putDocument('users', doc2, false);

        const map = await db.getAllDocumentsMap('users');
        expect(map.u1).toBeDefined();
        expect(map.u2).toBeDefined();
        expect((map.u1.data as any).name).toBe('Alice');
    });
});

// ─── replaceCollection ──────────────────────────────────────────────────────

describe('LocalDB — replaceCollection', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('clears and replaces all documents', async () => {
        const oldDoc = makeDoc(
            'u1',
            { name: 'Old' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', oldDoc, false);

        const newDocs = {
            u2: makeDoc(
                'u2',
                { name: 'New1' },
                {
                    name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
                },
            ),
            u3: makeDoc(
                'u3',
                { name: 'New2' },
                {
                    name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
                },
            ),
        };

        await db.replaceCollection('users', newDocs);

        const docs = await db.getAllDocuments('users');
        expect(docs).toHaveLength(2);
        expect(docs.map((d) => d.id)).toEqual(expect.arrayContaining(['u2', 'u3']));

        const oldDocCheck = await db.getDocument('users', 'u1');
        expect(oldDocCheck).toBeUndefined();
    });
});

// ─── mergeDocuments ─────────────────────────────────────────────────────────

describe('LocalDB — mergeDocuments', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('adds new documents from remote', async () => {
        const remoteDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Alice' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceB' },
                },
            ),
        };

        const count = await db.mergeDocuments('users', remoteDocs, (local, remote) => remote);
        expect(count).toBe(1);

        const doc = await db.getDocument('users', 'u1');
        expect(doc).toBeDefined();
        expect((doc!.data as any).name).toBe('Alice');
    });

    it('merges existing documents using the merge function', async () => {
        const localDoc = makeDoc(
            'u1',
            { name: 'Alice', email: 'alice@test.com' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                email: { updatedAt: '2026-07-27T11:00:00Z', device: 'deviceA' },
            },
        );
        await db.putDocument('users', localDoc, false);

        const remoteDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Alice Updated', email: 'alice@test.com' },
                {
                    name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceB' },
                    email: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceB' },
                },
            ),
        };

        // Simple merge: use remote
        const count = await db.mergeDocuments('users', remoteDocs, (_local, remote) => remote);
        expect(count).toBe(1);

        const doc = await db.getDocument('users', 'u1');
        expect((doc!.data as any).name).toBe('Alice Updated');
    });

    it('returns the count of updated documents', async () => {
        const remoteDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Alice' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceB' },
                },
            ),
            u2: makeDoc(
                'u2',
                { name: 'Bob' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceB' },
                },
            ),
        };

        const count = await db.mergeDocuments('users', remoteDocs, (_local, remote) => remote);
        expect(count).toBe(2);
    });
});

// ─── Changelog Queue ───────────────────────────────────────────────────────

describe('LocalDB — changelog queue', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('queues and retrieves changelog entries', async () => {
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u1',
            op: 'create',
            fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        const pending = await db.getPendingChangelogEntries();
        expect(pending).toHaveLength(1);
        expect(pending[0].collection).toBe('users');
        expect(pending[0].op).toBe('create');
    });

    it('returns entries ordered by queuedAt', async () => {
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u1',
            op: 'create',
            fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u2',
            op: 'create',
            fields: { name: { value: 'Bob', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        const pending = await db.getPendingChangelogEntries();
        expect(pending).toHaveLength(2);
        expect(pending[0].docId).toBe('u1');
        expect(pending[1].docId).toBe('u2');
    });

    it('returns pending count', async () => {
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u1',
            op: 'create',
            fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        const count = await db.getPendingChangelogCount();
        expect(count).toBe(1);
    });

    it('clears specific changelog entries by local ID', async () => {
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u1',
            op: 'create',
            fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
        });
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u2',
            op: 'create',
            fields: { name: { value: 'Bob', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        const pending = await db.getPendingChangelogEntries();
        const ids = pending.map((e) => e.localId!).slice(0, 1);

        await db.clearChangelogEntries(ids);

        const remaining = await db.getPendingChangelogEntries();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].docId).toBe('u2');
    });

    it('clears all changelog entries', async () => {
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u1',
            op: 'create',
            fields: { name: { value: 'Alice', updatedAt: '2026-07-27T10:00:00Z' } },
        });
        await db.queueChangelogEntry({
            collection: 'users',
            docId: 'u2',
            op: 'create',
            fields: { name: { value: 'Bob', updatedAt: '2026-07-27T10:00:00Z' } },
        });

        await db.clearAllChangelogEntries();

        const remaining = await db.getPendingChangelogEntries();
        expect(remaining).toHaveLength(0);
    });
});

// ─── Sync Metadata ──────────────────────────────────────────────────────────

describe('LocalDB — sync metadata', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
    });

    it('returns null cursor when no sync has occurred', async () => {
        const cursor = await db.getSyncCursor();
        expect(cursor).toBeNull();
    });

    it('saves and retrieves sync cursor', async () => {
        const cursor = { sha: 'abc123', timestamp: '2026-07-27T10:00:00Z' };
        await db.setSyncCursor(cursor);

        const retrieved = await db.getSyncCursor();
        expect(retrieved).toEqual(cursor);
    });

    it('returns 0 schema version when not set', async () => {
        const version = await db.getSchemaVersion();
        expect(version).toBe(0);
    });

    it('saves and retrieves schema version', async () => {
        await db.setSchemaVersion(3);

        const version = await db.getSchemaVersion();
        expect(version).toBe(3);
    });
});

// ─── exportAll ──────────────────────────────────────────────────────────────

describe('LocalDB — exportAll', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
        await db.registerCollection('users');
    });

    it('exports all registered collections including soft-deleted', async () => {
        const doc1 = makeDoc(
            'u1',
            { name: 'Alice' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );
        const doc2 = makeDoc(
            'u2',
            { name: 'Bob' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            { deleted_at: '2026-07-28T10:00:00Z', deleted_by: 'deviceA' },
        );

        await db.putDocument('users', doc1, false);
        await db.putDocument('users', doc2, false);

        const exported = await db.exportAll();

        expect(exported.users).toBeDefined();
        expect(Object.keys(exported.users)).toHaveLength(2);
        expect(exported.users.u1).toBeDefined();
        expect(exported.users.u2).toBeDefined();
    });
});

// ─── Error handling ─────────────────────────────────────────────────────────

describe('LocalDB — error handling', () => {
    let db: LocalDB;

    beforeEach(async () => {
        db = new LocalDB();
        await db.init();
    });

    it('throws when accessing an unregistered collection', async () => {
        await expect(db.getDocument('nonexistent', 'u1')).rejects.toThrow(
            'Collection "nonexistent" not registered',
        );
    });
});
