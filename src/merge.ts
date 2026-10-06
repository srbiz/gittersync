/**
 * GitterSync — Merge Algorithms
 *
 * Field-level Last-Write-Wins (LWW) merge for documents and collections.
 * Handles soft deletes with separate `deleted_at` tracking.
 */

import type { SyncedDocument, FieldsMap, ChangelogEntry, CollectionFile } from './types';

// ─── Document-Level Merge ──────────────────────────────────────────────────

/**
 * Merge two versions of the same document using field-level LWW.
 *
 * Rules:
 * 1. Each field has its own `updatedAt` in `_fields`
 * 2. The field value with the newer `updatedAt` wins
 * 3. If timestamps are identical, remote wins (server authority)
 * 4. `deleted_at` is checked separately — a newer edit overrides an older delete
 */
export function mergeDocument<T = Record<string, unknown>>(
    localDoc: SyncedDocument<T>,
    remoteDoc: SyncedDocument<T>,
): SyncedDocument<T> {
    // Start with remote as base
    const mergedData = { ...remoteDoc.data } as Record<string, unknown>;
    const mergedFields: FieldsMap = { ...remoteDoc._fields };

    const localFields = localDoc._fields;
    const remoteFields = remoteDoc._fields;

    // Collect all field names from both documents
    const allFieldNames = new Set([...Object.keys(localFields), ...Object.keys(remoteFields)]);

    for (const fieldName of allFieldNames) {
        const localMeta = localFields[fieldName];
        const remoteMeta = remoteFields[fieldName];

        if (!remoteMeta && localMeta) {
            // Field only exists locally — keep it
            (mergedData as Record<string, unknown>)[fieldName] = (
                localDoc.data as Record<string, unknown>
            )[fieldName];
            mergedFields[fieldName] = localMeta;
        } else if (remoteMeta && !localMeta) {
            // Field only exists remotely — already in merged base
            continue;
        } else if (localMeta && remoteMeta) {
            const localTime = new Date(localMeta.updatedAt).getTime();
            const remoteTime = new Date(remoteMeta.updatedAt).getTime();

            if (localTime > remoteTime) {
                // Local field is newer — use local value
                (mergedData as Record<string, unknown>)[fieldName] = (
                    localDoc.data as Record<string, unknown>
                )[fieldName];
                mergedFields[fieldName] = localMeta;
            }
            // If remote is newer or equal — keep remote (already in merged)
        }
    }

    // Handle deleted_at separately from updated_at
    const deletedAt = resolveDelete(localDoc, remoteDoc);

    // Compute document-level updated_at as the max of all field timestamps
    const updatedAt = computeDocUpdatedAt(mergedFields, localDoc.updated_at, remoteDoc.updated_at);

    return {
        id: localDoc.id,
        data: mergedData as T,
        _fields: mergedFields,
        updated_at: updatedAt,
        created_at: localDoc.created_at, // created_at never changes
        deleted_at: deletedAt,
        deleted_by: deletedAt
            ? deletedAt === localDoc.deleted_at
                ? localDoc.deleted_by
                : remoteDoc.deleted_by
            : null,
    };
}

/**
 * Resolve the `deleted_at` field between local and remote.
 *
 * Rules:
 * - If both have `deleted_at`, keep the newer one
 * - If only one has `deleted_at`, check if the other side has a newer edit
 *   - A newer edit (updated_at > deleted_at) overrides the delete
 *   - Otherwise, keep the delete
 */
function resolveDelete<T>(
    localDoc: SyncedDocument<T>,
    remoteDoc: SyncedDocument<T>,
): string | null {
    const localDeletedAt = localDoc.deleted_at;
    const remoteDeletedAt = remoteDoc.deleted_at;

    if (!localDeletedAt && !remoteDeletedAt) {
        return null;
    }

    if (localDeletedAt && !remoteDeletedAt) {
        // Local was deleted, remote was not — check if remote has a newer edit
        if (new Date(remoteDoc.updated_at) > new Date(localDeletedAt)) {
            return null; // Remote edit overrides local delete
        }
        return localDeletedAt;
    }

    if (!localDeletedAt && remoteDeletedAt) {
        // Remote was deleted, local was not — check if local has a newer edit
        if (new Date(localDoc.updated_at) > new Date(remoteDeletedAt)) {
            return null; // Local edit overrides remote delete
        }
        return remoteDeletedAt;
    }

    // Both deleted — keep the newer delete
    if (new Date(localDeletedAt!) > new Date(remoteDeletedAt!)) {
        return localDeletedAt;
    }
    return remoteDeletedAt;
}

/**
 * Compute the document-level `updated_at` as the maximum of all field timestamps.
 */
function computeDocUpdatedAt(
    fields: FieldsMap,
    localUpdatedAt: string,
    remoteUpdatedAt: string,
): string {
    const fieldTimestamps = Object.values(fields).map((f) => new Date(f.updatedAt).getTime());
    const docTimestamps = [
        ...fieldTimestamps,
        new Date(localUpdatedAt).getTime(),
        new Date(remoteUpdatedAt).getTime(),
    ];
    const maxTime = Math.max(...docTimestamps);
    return new Date(maxTime).toISOString();
}

// ─── Collection-Level Merge ────────────────────────────────────────────────

/**
 * Merge local and remote collections using field-level LWW per document.
 *
 * - Documents only in local → add to merged
 * - Documents only in remote → add to merged
 * - Documents in both → field-level merge
 * - Handles deleted documents per the `deleted_at` rules
 */
export function mergeCollection<T = Record<string, unknown>>(
    localDocs: Record<string, SyncedDocument<T>>,
    remoteDocs: Record<string, SyncedDocument<T>>,
): Record<string, SyncedDocument<T>> {
    const merged: Record<string, SyncedDocument<T>> = {};

    // Start with all remote documents
    for (const [id, doc] of Object.entries(remoteDocs)) {
        merged[id] = doc;
    }

    // Merge local documents
    for (const [id, localDoc] of Object.entries(localDocs)) {
        const remoteDoc = remoteDocs[id];

        if (!remoteDoc) {
            // New local document — add it
            merged[id] = localDoc;
        } else {
            // Both exist — field-level merge
            merged[id] = mergeDocument(localDoc, remoteDoc);
        }
    }

    return merged;
}

// ─── Changelog Application ────────────────────────────────────────────────

/**
 * Apply changelog entries to a collection file.
 *
 * Used during compaction and during pull when processing remote changelogs.
 */
export function applyChangelogToCollection<T = Record<string, unknown>>(
    collectionData: CollectionFile<T>,
    changes: ChangelogEntry[],
    deviceId: string,
): CollectionFile<T> {
    const docs: Record<string, SyncedDocument<T>> = {
        ...collectionData.documents,
    };

    for (const change of changes) {
        const existing = docs[change.docId];

        if (change.op === 'create') {
            const newData: Record<string, unknown> = {};
            const newFields: FieldsMap = {};

            for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
                newData[fieldName] = fieldData.value;
                newFields[fieldName] = {
                    updatedAt: fieldData.updatedAt,
                    device: deviceId,
                };
            }

            const firstFieldTime =
                Object.values(newFields)[0]?.updatedAt || new Date().toISOString();

            docs[change.docId] = {
                id: change.docId,
                data: newData as T,
                _fields: newFields,
                updated_at: firstFieldTime,
                created_at: firstFieldTime,
                deleted_at: null,
                deleted_by: null,
            };
        } else if (change.op === 'update') {
            // An update for a document we have never seen is still valid data:
            // the creating side may have batched it as 'update' (e.g. putDocument)
            // or the create may live in a changelog this device has not read yet.
            // Treat it as an upsert so the change is never silently dropped.
            if (!existing) {
                const newData: Record<string, unknown> = {};
                const newFields: FieldsMap = {};

                for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
                    newData[fieldName] = fieldData.value;
                    newFields[fieldName] = {
                        updatedAt: fieldData.updatedAt,
                        device: deviceId,
                    };
                }

                const firstFieldTime =
                    Object.values(newFields)[0]?.updatedAt || new Date().toISOString();

                docs[change.docId] = {
                    id: change.docId,
                    data: newData as T,
                    _fields: newFields,
                    updated_at: firstFieldTime,
                    created_at: firstFieldTime,
                    deleted_at: null,
                    deleted_by: null,
                };
                continue;
            }

            const updatedData = { ...(existing.data as Record<string, unknown>) };
            const updatedFields = { ...existing._fields };

            for (const [fieldName, fieldData] of Object.entries(change.fields || {})) {
                const current = updatedFields[fieldName];
                const incomingTime = new Date(fieldData.updatedAt).getTime();
                const currentTime = current ? new Date(current.updatedAt).getTime() : -Infinity;

                // Field-level LWW, matching the local apply path. Changelog
                // entries carry *every* field of a document (putDocument echoes
                // them all), so without this guard a stale echo could roll back
                // a newer value and re-attribute its provenance.
                if (current && incomingTime <= currentTime) continue;

                updatedData[fieldName] = fieldData.value;
                updatedFields[fieldName] = {
                    updatedAt: fieldData.updatedAt,
                    device: deviceId,
                };
            }

            // Compute updated_at as max of all field timestamps
            const allTimestamps = Object.values(updatedFields).map((f) =>
                new Date(f.updatedAt).getTime(),
            );
            const maxTimestamp = Math.max(...allTimestamps);

            docs[change.docId] = {
                ...existing,
                data: updatedData as T,
                _fields: updatedFields,
                updated_at: new Date(maxTimestamp).toISOString(),
            };
        } else if (change.op === 'delete') {
            const deletedAt = change.deletedAt || new Date().toISOString();

            if (!existing) {
                // The document is unknown here (created and deleted before this
                // device ever saw it). Record a tombstone so the deletion is not
                // lost and the document cannot be resurrected by an older copy.
                docs[change.docId] = {
                    id: change.docId,
                    data: {} as T,
                    _fields: {},
                    updated_at: deletedAt,
                    created_at: deletedAt,
                    deleted_at: deletedAt,
                    deleted_by: deviceId,
                };
                continue;
            }

            docs[change.docId] = {
                ...existing,
                deleted_at: deletedAt,
                deleted_by: deviceId,
            };
        }
    }

    return {
        ...collectionData,
        documents: docs,
        version: collectionData.version + 1,
        updatedAt: new Date().toISOString(),
    };
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Create a new SyncedDocument from raw data.
 */
export function createDocument<T = Record<string, unknown>>(
    id: string,
    data: T,
    deviceId: string,
    timestamp?: string,
): SyncedDocument<T> {
    const now = timestamp || new Date().toISOString();
    const fields: FieldsMap = {};

    for (const fieldName of Object.keys(data as Record<string, unknown>)) {
        fields[fieldName] = {
            updatedAt: now,
            device: deviceId,
        };
    }

    return {
        id,
        data,
        _fields: fields,
        updated_at: now,
        created_at: now,
        deleted_at: null,
        deleted_by: null,
    };
}

/**
 * Create a changelog entry from a document change.
 */
export function createChangelogEntry(
    collection: string,
    docId: string,
    op: 'create' | 'update' | 'delete',
    changedFields?: Record<string, { value: unknown; updatedAt: string }>,
    deletedAt?: string,
): ChangelogEntry {
    const entry: ChangelogEntry = {
        collection,
        docId,
        op,
    };

    if (changedFields) {
        entry.fields = {};
        for (const [fieldName, fieldData] of Object.entries(changedFields)) {
            entry.fields[fieldName] = {
                value: fieldData.value,
                updatedAt: fieldData.updatedAt,
            };
        }
    }

    if (op === 'delete' && deletedAt) {
        entry.deletedAt = deletedAt;
    }

    return entry;
}

/**
 * Filter out soft-deleted documents older than the given age.
 * Returns the IDs of documents that should be purged.
 */
export function getExpiredDeletes<T>(
    documents: Record<string, SyncedDocument<T>>,
    maxAgeMs: number,
): string[] {
    const cutoff = Date.now() - maxAgeMs;
    return Object.entries(documents)
        .filter(([, doc]) => {
            if (!doc.deleted_at) return false;
            return new Date(doc.deleted_at).getTime() < cutoff;
        })
        .map(([id]) => id);
}
