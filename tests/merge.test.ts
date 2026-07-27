/**
 * GitterSync — Merge Algorithm Tests
 */

import { describe, it, expect } from 'vitest';
import {
    mergeDocument,
    mergeCollection,
    applyChangelogToCollection,
    createDocument,
    createChangelogEntry,
    getExpiredDeletes,
} from '../src/merge';
import type { SyncedDocument, CollectionFile, ChangelogEntry } from '../src/types';

// ─── Test Fixtures ─────────────────────────────────────────────────────────

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

// ─── mergeDocument ─────────────────────────────────────────────────────────

describe('mergeDocument', () => {
    it('keeps local-only fields', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane', email: 'jane@test.com' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                email: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        expect((merged.data as any).name).toBe('Jane');
        expect((merged.data as any).email).toBe('jane@test.com');
        expect(merged._fields.email.device).toBe('deviceA');
    });

    it('keeps remote-only fields', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane', email: 'jane@test.com' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                email: { updatedAt: '2026-07-27T11:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        expect((merged.data as any).email).toBe('jane@test.com');
        expect(merged._fields.email.device).toBe('deviceB');
    });

    it('resolves conflicting fields by timestamp — local wins', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane Updated' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane Old' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        expect((merged.data as any).name).toBe('Jane Updated');
        expect(merged._fields.name.device).toBe('deviceA');
    });

    it('resolves conflicting fields by timestamp — remote wins', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane Old' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane Updated' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        expect((merged.data as any).name).toBe('Jane Updated');
        expect(merged._fields.name.device).toBe('deviceB');
    });

    it('preserves independent field changes from both sides', () => {
        // Device A updates name, Device B updates email — both should be preserved
        const local = makeDoc(
            'u1',
            { name: 'Jane New', email: 'jane@old.com' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
                email: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane Old', email: 'jane@new.com' },
            {
                name: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceB' },
                email: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        expect((merged.data as any).name).toBe('Jane New'); // deviceA won (newer)
        expect((merged.data as any).email).toBe('jane@new.com'); // deviceB won (newer)
    });

    it('gives remote priority on equal timestamps', () => {
        const local = makeDoc(
            'u1',
            { name: 'Local' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Remote' },
            {
                name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceB' },
            },
        );

        const merged = mergeDocument(local, remote);

        // Equal timestamps → remote wins (server authority)
        expect((merged.data as any).name).toBe('Remote');
    });
});

// ─── mergeDocument — delete handling ────────────────────────────────────────

describe('mergeDocument — delete handling', () => {
    it('applies remote delete when no local edit is newer', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            {
                deleted_at: '2026-07-27T12:00:00Z',
                deleted_by: 'deviceB',
            },
        );

        const merged = mergeDocument(local, remote);

        expect(merged.deleted_at).toBe('2026-07-27T12:00:00Z');
    });

    it('restores document when local edit is newer than remote delete', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane Updated' },
            {
                name: { updatedAt: '2026-07-27T14:00:00Z', device: 'deviceA' },
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            {
                deleted_at: '2026-07-27T12:00:00Z',
                deleted_by: 'deviceB',
            },
        );

        const merged = mergeDocument(local, remote);

        expect(merged.deleted_at).toBeNull();
        expect((merged.data as any).name).toBe('Jane Updated');
    });

    it('keeps the newer delete when both sides deleted', () => {
        const local = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            {
                deleted_at: '2026-07-27T14:00:00Z',
                deleted_by: 'deviceA',
            },
        );

        const remote = makeDoc(
            'u1',
            { name: 'Jane' },
            {
                name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
            },
            {
                deleted_at: '2026-07-27T12:00:00Z',
                deleted_by: 'deviceB',
            },
        );

        const merged = mergeDocument(local, remote);

        expect(merged.deleted_at).toBe('2026-07-27T14:00:00Z'); // Local is newer
    });
});

// ─── mergeCollection ───────────────────────────────────────────────────────

describe('mergeCollection', () => {
    it('adds local-only documents', () => {
        const localDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Jane' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                },
            ),
        };

        const remoteDocs = {
            u2: makeDoc(
                'u2',
                { name: 'Bob' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceB' },
                },
            ),
        };

        const merged = mergeCollection(localDocs, remoteDocs);

        expect(Object.keys(merged)).toHaveLength(2);
        expect(merged.u1).toBeDefined();
        expect(merged.u2).toBeDefined();
    });

    it('merges overlapping documents', () => {
        const localDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Jane', email: 'jane@old.com' },
                {
                    name: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceA' },
                    email: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceA' },
                },
            ),
        };

        const remoteDocs = {
            u1: makeDoc(
                'u1',
                { name: 'Jane Old', email: 'jane@new.com' },
                {
                    name: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceB' },
                    email: { updatedAt: '2026-07-27T12:00:00Z', device: 'deviceB' },
                },
            ),
        };

        const merged = mergeCollection(localDocs, remoteDocs);

        expect(Object.keys(merged)).toHaveLength(1);
        expect((merged.u1.data as any).name).toBe('Jane'); // local won
        expect((merged.u1.data as any).email).toBe('jane@new.com'); // remote won
    });

    it('handles empty collections', () => {
        const merged = mergeCollection({}, {});
        expect(Object.keys(merged)).toHaveLength(0);
    });
});

// ─── applyChangelogToCollection ────────────────────────────────────────────

describe('applyChangelogToCollection', () => {
    const emptyCollection: CollectionFile = {
        collection: 'users',
        version: 1,
        updatedAt: '2026-07-27T00:00:00Z',
        documents: {},
    };

    it('creates new documents from changelog', () => {
        const changes: ChangelogEntry[] = [
            {
                collection: 'users',
                docId: 'u1',
                op: 'create',
                fields: {
                    name: { value: 'Jane Doe', updatedAt: '2026-07-27T10:00:00Z' },
                    email: { value: 'jane@test.com', updatedAt: '2026-07-27T10:00:00Z' },
                },
            },
        ];

        const result = applyChangelogToCollection(emptyCollection, changes, 'deviceA');

        expect(result.documents.u1).toBeDefined();
        expect((result.documents.u1.data as any).name).toBe('Jane Doe');
        expect(result.version).toBe(2);
    });

    it('updates existing documents', () => {
        const collection: CollectionFile = {
            collection: 'users',
            version: 1,
            updatedAt: '2026-07-27T00:00:00Z',
            documents: {
                u1: makeDoc(
                    'u1',
                    { name: 'Jane' },
                    {
                        name: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceA' },
                    },
                ),
            },
        };

        const changes: ChangelogEntry[] = [
            {
                collection: 'users',
                docId: 'u1',
                op: 'update',
                fields: {
                    name: { value: 'Jane Updated', updatedAt: '2026-07-27T12:00:00Z' },
                },
            },
        ];

        const result = applyChangelogToCollection(collection, changes, 'deviceB');

        expect((result.documents.u1.data as any).name).toBe('Jane Updated');
        expect(result.documents.u1._fields.name.updatedAt).toBe('2026-07-27T12:00:00Z');
    });

    it('soft-deletes documents', () => {
        const collection: CollectionFile = {
            collection: 'users',
            version: 1,
            updatedAt: '2026-07-27T00:00:00Z',
            documents: {
                u1: makeDoc(
                    'u1',
                    { name: 'Jane' },
                    {
                        name: { updatedAt: '2026-07-27T09:00:00Z', device: 'deviceA' },
                    },
                ),
            },
        };

        const changes: ChangelogEntry[] = [
            {
                collection: 'users',
                docId: 'u1',
                op: 'delete',
                deletedAt: '2026-07-27T12:00:00Z',
            },
        ];

        const result = applyChangelogToCollection(collection, changes, 'deviceB');

        expect(result.documents.u1.deleted_at).toBe('2026-07-27T12:00:00Z');
        expect(result.documents.u1.deleted_by).toBe('deviceB');
    });

    it('increments version on each application', () => {
        const result = applyChangelogToCollection(emptyCollection, [], 'deviceA');
        expect(result.version).toBe(2); // 1 + 1 even with no changes
    });
});

// ─── createDocument ────────────────────────────────────────────────────────

describe('createDocument', () => {
    it('creates a document with field metadata', () => {
        const doc = createDocument('u1', { name: 'Jane', email: 'jane@test.com' }, 'deviceA');

        expect(doc.id).toBe('u1');
        expect((doc.data as any).name).toBe('Jane');
        expect(doc._fields.name).toBeDefined();
        expect(doc._fields.name.device).toBe('deviceA');
        expect(doc._fields.email).toBeDefined();
        expect(doc.created_at).toBeTruthy();
        expect(doc.deleted_at).toBeNull();
    });

    it('uses the provided timestamp', () => {
        const ts = '2026-07-27T12:00:00Z';
        const doc = createDocument('u1', { name: 'Jane' }, 'deviceA', ts);

        expect(doc.created_at).toBe(ts);
        expect(doc._fields.name.updatedAt).toBe(ts);
    });
});

// ─── createChangelogEntry ─────────────────────────────────────────────────

describe('createChangelogEntry', () => {
    it('creates an update entry', () => {
        const entry = createChangelogEntry('users', 'u1', 'update', {
            name: { value: 'Jane', updatedAt: '2026-07-27T12:00:00Z' },
        });

        expect(entry.collection).toBe('users');
        expect(entry.docId).toBe('u1');
        expect(entry.op).toBe('update');
        expect(entry.fields?.name.value).toBe('Jane');
    });

    it('creates a delete entry', () => {
        const entry = createChangelogEntry(
            'users',
            'u1',
            'delete',
            undefined,
            '2026-07-27T12:00:00Z',
        );

        expect(entry.op).toBe('delete');
        expect(entry.deletedAt).toBe('2026-07-27T12:00:00Z');
    });
});

// ─── getExpiredDeletes ─────────────────────────────────────────────────────

describe('getExpiredDeletes', () => {
    it('returns IDs of expired soft-deletes', () => {
        const docs = {
            u1: makeDoc(
                'u1',
                { name: 'Jane' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                },
                { deleted_at: '2026-06-01T00:00:00Z', deleted_by: 'deviceA' },
            ),
            u2: makeDoc(
                'u2',
                { name: 'Bob' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                },
                { deleted_at: '2026-07-27T00:00:00Z', deleted_by: 'deviceA' },
            ),
            u3: makeDoc(
                'u3',
                { name: 'Alice' },
                {
                    name: { updatedAt: '2026-07-27T10:00:00Z', device: 'deviceA' },
                },
            ),
        };

        // 30 days in ms
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        const expired = getExpiredDeletes(docs, thirtyDays);

        // u1 was deleted over 30 days ago (June 1 vs now ~July 27)
        // u2 was deleted recently (July 27)
        // u3 is not deleted
        expect(expired).toContain('u1');
        expect(expired).not.toContain('u2');
        expect(expired).not.toContain('u3');
    });
});
