# GitterSync

**GitHub as a free database backend** — offline-first sync with per-collection files, incremental changelogs, and field-level conflict resolution.

[![Live Demo](https://img.shields.io/badge/demo-live-00d4aa?style=for-the-badge)](https://srbiz.github.io/gittersync/)
[![npm version](https://img.shields.io/npm/v/gittersync?color=00d4aa&label=npm)](https://www.npmjs.com/package/gittersync)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal)](https://paypal.me/GovindBhumkarIN)

## 🎮 Live Demos

Two apps, same library, no backend — the GitHub repository is the database.

| Demo             | Stack                                   | Link                                                                                                  |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Kanban board** | Vanilla TypeScript + Vite               | [srbiz.github.io/gittersync](https://srbiz.github.io/gittersync/) · [`demo/`](demo)                   |
| **Todo**         | Vue 3 (`<script setup>`) + Vite + Pinia | [srbiz.github.io/gittersync/todo](https://srbiz.github.io/gittersync/todo/) · [`demo-vue/`](demo-vue) |

The **Kanban Board** is a fully functional project management app that showcases every feature of the library:

- ✅ **Task CRUD** with offline-first sync
- ✅ **Drag & drop** between columns (field-level conflict resolution)
- ✅ **File attachments** with files-first ordering
- ✅ **Auto-sync** with configurable interval
- ✅ **Online/offline detection** with auto-retry on reconnect
- ✅ **Real-time status dashboard** (sync cursor, pending changes, rate limit)
- ✅ **Token encryption** with AES-256-GCM passphrase protection

The **Todo** demo is the minimal version of the same idea — one Pinia store, four
components, and a "Try it offline (no GitHub)" button that runs the library's
`LocalDB` on its own. It is the fastest thing to read if you want to copy a
working offline-first setup into your own app
([`demo-vue/README.md`](demo-vue/README.md)).

> **Quick start:** Open a demo, enter a GitHub PAT with `repo` scope, and start creating tasks. The default demo repo is ready to use!
>
> 🔧 New to GitHub? See the [GitHub Setup FAQ](docs/github-setup.md) for help with tokens, repos, and common questions.

### 🔑 GitHub Token Guidance

To use the demo or the library, you need a GitHub Personal Access Token (PAT). You can use either:

1.  **Classic Token (Recommended for Demo):**
    - Go to [Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens).
    - Generate a new token with the **`repo`** scope.
    - This is the simplest way to get started.

2.  **Fine-grained Token:**
    - Go to [Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
    - Select the repository you want to use as a database.
    - Grant **Read and write** access to **"Contents"** and **"Metadata"**.
    - This is more secure but requires manual repo selection.

## How It Works

GitterSync stores your app data in a GitHub repository using a structured file format. Each collection (e.g. `users`, `posts`) gets its own JSON file, and incremental changes are tracked through changelog files. Sync uses the GitHub Compare Commits API to only download what changed since the last sync.

### Key Architecture Decisions

- **Per-collection files** — `collections/users.json`, `collections/posts.json` — avoids the single-file bottleneck
- **Incremental changelog sync** — only transmit what changed; uses GitHub's Compare Commits API
- **Field-level LWW (Last-Write-Wins)** — each field has its own `updatedAt` timestamp; concurrent edits to different fields are preserved
- **Sync cursor (commit SHA)** — instead of timestamp-based tracking; enables efficient incremental pull
- **Files-first ordering** — binary uploads happen before metadata updates to prevent dangling references
- **Compaction** — changelog entries are merged into collection files when threshold is exceeded

### Data Format

Each document tracks field-level metadata for conflict resolution:

```json
{
    "id": "user-123",
    "data": { "name": "Alice", "email": "alice@example.com" },
    "_fields": {
        "name": { "updatedAt": "2026-07-27T10:00:00Z", "device": "deviceA" },
        "email": { "updatedAt": "2026-07-27T09:00:00Z", "device": "deviceB" }
    },
    "updated_at": "2026-07-27T10:00:00Z",
    "created_at": "2026-07-01T00:00:00Z",
    "deleted_at": null,
    "deleted_by": null
}
```

## Installation

```bash
npm install gittersync
```

### Peer Requirements

This library requires a browser environment (or browser-like) for:

- **IndexedDB** — via Dexie.js for local storage
- **Web Crypto API** — for AES-256-GCM token encryption
- **localStorage** — for encrypted token storage

## Quick Start

```typescript
import { GitHubSyncService, storeToken, retrieveToken } from 'gittersync';

// 1. Create a sync service
const sync = new GitHubSyncService({
    owner: 'your-username',
    repo: 'your-data-repo',
    branch: 'main',
    useRawContent: true, // default — reads skip the REST rate limit
    compactionThreshold: 20, // compact after 20 remote changelog files
    deleteRetentionMs: 30 * 24 * 60 * 60 * 1000, // purge soft-deletes after 30 days
    onSyncStatusChange: (status) => renderBadge(status),
});

// 2. Initialize with a GitHub Personal Access Token
// (encrypt it first — see Token Security below)
await sync.init(token);

// 3. Register your collections
await sync.registerCollections(['users', 'posts']);

// 4. Pull remote data into local IndexedDB
const result = await sync.pull();
console.log(result.type); // 'full' | 'incremental' | 'none'

// 5. Read and write locally — no network involved
const db = sync.getLocalDb();
const id = crypto.randomUUID();
await db.create('users', id, { name: 'Ada', role: 'admin' });
await db.updateFields('users', id, { role: 'owner' }); // stamps only `role`
const admins = await db.queryDocuments('users', (u) => u.role !== 'member');

// 6. Push local changes to GitHub (uploads one small changelog file)
await sync.push();

// 7. Full sync (pull + push with bounded conflict retry)
const synced = await sync.sync();
console.log(synced.type, synced.pushed);

// 8. Or let it run itself
sync.startAutoSync(30_000);
```

## Token Security

GitterSync provides AES-256-GCM encryption for storing GitHub tokens in `localStorage`:

```typescript
import { storeToken, retrieveToken, hasStoredToken, clearStoredToken } from 'gittersync';

// Encrypt and store the token with a user-provided passphrase
await storeToken('ghp_xxxxxxxxxxxx', 'user-passphrase');

// Retrieve and decrypt
const token = await retrieveToken('user-passphrase');

// Check if a token is stored
if (hasStoredToken()) {
    /* ... */
}

// Remove the stored token
clearStoredToken();
```

> **Note:** For production apps, GitHub OAuth is recommended over PAT storage. The encryption utility is a fallback for scenarios where OAuth isn't feasible.

## Auto-Sync

```typescript
// Start periodic sync every 5 minutes (default)
sync.startAutoSync();

// Custom interval
sync.startAutoSync(2 * 60 * 1000); // every 2 minutes

// Stop auto-sync
sync.stopAutoSync();
```

### Online/Offline Detection

GitterSync automatically detects browser connectivity and handles offline scenarios:

- **Skip sync when offline** — `startAutoSync()` checks `navigator.onLine` before each sync cycle and skips if the browser is offline, avoiding wasted network errors
- **Auto-retry on reconnect** — when the browser fires the `online` event, GitterSync immediately triggers a sync so changes are pushed as soon as connectivity returns
- **Visibility** — the `isOnline` property and `SyncStatus.isOnline` field let your UI reflect the current connectivity state

```typescript
// Check connectivity state
console.log(sync.isOnline); // true | false

// In non-browser environments (Node.js), isOnline defaults to true
```

> **Note:** Online/offline detection uses the browser's `navigator.onLine` property and `online`/`offline` events. In non-browser environments (Node.js, SSR), `isOnline` defaults to `true` since there's no standard connectivity API.

## Schema Migrations

GitterSync supports a configurable migration pipeline that runs automatically when the remote `schemaVersion` in `meta.json` is higher than the local one. This allows your app to evolve its data model without breaking existing data.

```typescript
import { type MigrationStep, GitHubSyncService } from 'gittersync';

const migrations: MigrationStep[] = [
    {
        from: 0,
        to: 1,
        description: 'Add version field to all documents',
        transform: (collection, documents, meta) => {
            const result: Record<string, SyncedDocument> = {};
            for (const [id, doc] of Object.entries(documents)) {
                result[id] = {
                    ...doc,
                    data: { ...doc.data, version: 1 },
                };
            }
            return result;
        },
    },
    {
        from: 1,
        to: 2,
        description: 'Add status field to users collection only',
        transform: (collection, documents, meta) => {
            if (collection !== 'users') return documents;
            const result: Record<string, SyncedDocument> = {};
            for (const [id, doc] of Object.entries(documents)) {
                result[id] = {
                    ...doc,
                    data: { ...doc.data, status: 'active' },
                };
            }
            return result;
        },
    },
];

const sync = new GitHubSyncService({
    owner: 'your-username',
    repo: 'your-data-repo',
    migrations,
});
```

### How It Works

1. On `pull()`, after downloading collection files but before merging into the local database, GitterSync compares the remote `schemaVersion` (from `meta.json`) with the local `schemaVersion` (stored in IndexedDB)
2. If the remote version is higher, each applicable `MigrationStep` transform runs in order of `from` version
3. After all migrations, the local schema version is updated to match the remote version
4. If no migrations are configured but the remote version is higher, the local version is simply updated — no data is transformed

> **Important:** All devices must use the same migration definitions. Mismatched migrations can lead to data inconsistencies across devices.

## Data Export/Import

Export all data from GitHub as a ZIP file for backup, or import a ZIP to restore data on a new device. The import clears the sync cursor, forcing a full re-sync on the next pull.

```typescript
// Export all data as a downloadable ZIP
const zipBlob = await sync.exportData();

// Save as a file (browser)
const url = URL.createObjectURL(zipBlob);
const a = document.createElement('a');
a.href = url;
a.download = `gittersync-export-${new Date().toISOString().slice(0, 10)}.zip`;
a.click();
URL.revokeObjectURL(url);

// Import from a ZIP file (File or Blob)
const fileInput = document.getElementById('import-input') as HTMLInputElement;
const file = fileInput.files?.[0];
if (file) {
    await sync.importData(file);
    // Sync cursor is cleared — next pull() will do a full re-sync
}
```

### Export ZIP Structure

```
gittersync-export/
├── manifest.json              # Export metadata
├── meta.json                  # Remote meta.json (if present)
├── collections/
│   ├── users.json             # Per-collection document store
│   └── posts.json
├── changelog/
│   └── 2026-07-27_deviceA.json
└── files/
    └── avatar.png             # Binary file attachments
```

### manifest.json Format

```json
{
    "exportedAt": "2026-07-28T12:00:00Z",
    "sourceVersion": "1.3.1",
    "collections": ["users", "posts"],
    "changelogCount": 3,
    "fileCount": 2
}
```

### Import Validation

`importData()` validates the ZIP before applying any data:

- **Non-ZIP files** throw a `ValidationError` with "Invalid or corrupted ZIP file"
- **Missing `manifest.json`** throws a `ValidationError`
- **No collection files** in the `collections/` directory throws a `ValidationError`

The import preserves the local device ID — only collection data, schema version, and the sync cursor are affected.

### API

| Method             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `exportData()`     | Fetch all data from GitHub and return as a ZIP Blob |
| `importData(file)` | Parse a ZIP file and replace local data             |

## Binary File Sync

```typescript
// Upload — accepts a File/Blob, a base64 string, a data: URL, an
// ArrayBuffer or a Uint8Array. The path is used exactly as given
// (`files/` is a convention, not a prefix the library adds).
const fileRef = await sync.uploadFile(`files/${userId}/avatar.png`, file);
// → { path: 'files/u-1/avatar.png', sha: 'a1b2…', size: 184320, mimeType: 'image/png' }

// Store the FileRef inside a document — that is the whole attachment model
await db.updateFields('users', userId, { avatar: fileRef });

// Download (a raw read: 0 REST calls)
const blob = await sync.downloadFile(fileRef.path);

// List everything under a directory (1 REST call, any depth)
const paths = await sync.listFiles('files');

// Delete
await sync.deleteFile(fileRef.path);
```

Files larger than **1 MiB** (`MAX_CONTENT_API_BYTES`, GitHub's Contents API
limit) are rejected with a `ValidationError` before any network call.

## Compaction

Changelog entries accumulate over time. Compaction merges them into the main collection files and purges expired soft-deletes:

```typescript
await sync.compact();
```

Compaction is also automatically triggered during `push()` once the repository
holds `compactionThreshold` changelog **files** (one file per device per push).
It returns what it did:

```typescript
const result = await sync.compact();
// { changelogsCompacted: 21, collectionsWritten: ['users'], purgedDeletes: 4, apiCalls: 24 }
```

Soft-deletes are only purged once they are older than `deleteRetentionMs`
(30 days by default) — purging earlier can resurrect a deleted document on a
device that has not synced in a while.

## Conflict Resolution

GitterSync uses **field-level Last-Write-Wins (LWW)**:

1. When two devices edit different fields of the same document, both changes are preserved
2. When two devices edit the same field, the one with the later timestamp wins
3. On equal timestamps, the remote version takes priority
4. Soft-deletes use a separate `deleted_at` field — a newer edit overrides an older delete

## Sync Status

```typescript
const status = sync.getStatus(); // synchronous, zero REST calls — cached values
// {
//   isSyncing: boolean
//   isOnline: boolean           // current connectivity state
//   isInitialized: boolean
//   lastSyncAt: string | null   // last completed pull/push
//   pendingChanges: number      // changelog entries waiting to be pushed
//   deviceId: string
//   cursor: SyncCursor | null
//   repoSizeKb: number | null
//   rateLimitRemaining: number | null
//   rateLimitResetAt: string | null
//   rawContentActive: boolean   // reads currently served free of the rate limit
// }

const fullStatus = await sync.getFullStatus(); // refreshes repo size + rate limit (1–2 calls)

const info = sync.getRateLimitInfo();
// { remaining, resetAt, apiCalls, rawReads, rawMisses, rawFallbacks, rawContentActive }
```

`onSyncStatusChange` pushes the same object on every state change, so a UI can
render from either.

## Rate Limits & Raw Content

GitHub gives you **5,000 REST calls/hour** authenticated (60/hour anonymous).
When a repository is your database, reads are what eat that budget — so
GitterSync reads file contents from `raw.githubusercontent.com`, which is **not**
part of the REST rate limit. This is on by default.

```typescript
const sync = new GitHubSyncService({
    owner: 'you',
    repo: 'your-data',
    useRawContent: true, // default — set false for strict REST read-after-write
    rawCacheBust: true, // default — defeats CDN caching with ?cb=<random>
    rawBaseUrl: 'https://raw.githubusercontent.com', // default
    requestTimeoutMs: 30_000, // default
});
```

| Operation                             | REST calls                               |
| ------------------------------------- | ---------------------------------------- |
| Incremental `pull()`, nothing changed | 1 (Compare Commits, **zero** downloads)  |
| Incremental `pull()` with changes     | 1 + writes — changed files are raw reads |
| `push()` with pending changes         | 2–4                                      |
| `downloadFile()`                      | **0**                                    |
| `uploadFile()`                        | 1–2                                      |
| `getStatus()`                         | **0**                                    |

Writes cost 1 call when the blob SHA is cached (the normal case — SHAs are
learned from reads and from write responses) and 2 the first time. Full table in
[`docs/api.md`](docs/api.md#rate-limit-budget).

Three rules keep this correct rather than merely fast:

- **Write-critical reads bypass raw.** Compaction rewrites whole files, so it
  reads with `{ forceApi: true }` — a CDN-cached copy could resurrect data another
  device just compacted.
- **A private repository is never read anonymously.** An anonymous 404 on a
  private repo would look like "file does not exist" and cause silent data loss,
  so raw reads are disabled and the REST API is used instead.
- **The cursor never advances past commits you did not read.** A push only moves
  the cursor when its commit lists the local cursor among its parents
  (`WriteResult.parentShas`); if another device committed in between, the next
  pull picks up both.

Check what a session actually cost:

```typescript
const info = sync.getRateLimitInfo();
console.log(`${info.rawReads + info.rawMisses} free reads, ${info.apiCalls} API calls`);
```

## API Reference

Full reference for every export — including the complete
[`LocalDB`](docs/api.md#localdb) API, the
[`GitHubApiAdapter`](docs/api.md#githubapiadapter), merge helpers, token
encryption, config constants, all types and error classes — lives in
**[`docs/api.md`](docs/api.md)**.

### `GitHubSyncService`

| Method                                            | Description                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `init(token)`                                     | Initialize with GitHub token                                                                  |
| `registerCollections(names)`                      | Register collection names (required before first use)                                         |
| `pull()`                                          | Pull remote changes (full or incremental)                                                     |
| `push()`                                          | Push local changelog entries to GitHub                                                        |
| `sync()`                                          | Pull then push with bounded conflict retry — returns `SyncResult` (`pull` outcome + `pushed`) |
| `compact()`                                       | Merge changelogs into collections, purge expired deletes                                      |
| `uploadFile(path, content, message?, mimeType?)`  | Upload a `Blob`/`File`/base64/`Uint8Array`/`ArrayBuffer` — returns a `FileRef`                |
| `downloadFile(path, options?)`                    | Download a file as a `Blob` (raw read, 0 REST calls)                                          |
| `deleteFile(path, message?)`                      | Delete a file (idempotent)                                                                    |
| `listFiles(dir?)`                                 | Recursive listing via the Git Trees API (1 call, any depth)                                   |
| `exportData()` / `importData(file)`               | ZIP the whole repository / restore from such a ZIP                                            |
| `startAutoSync(intervalMs?)`                      | Periodic sync (skips offline, resumes on reconnect, pauses on rate limit)                     |
| `stopAutoSync()`                                  | Stop periodic sync                                                                            |
| `destroy()`                                       | Stop timers, remove listeners, close IndexedDB — call on teardown                             |
| `reset()`                                         | Wipe local state (keeps device id and GitHub data), then re-pull                              |
| `getStatus()`                                     | Cached sync status — synchronous, 0 REST calls                                                |
| `getFullStatus()`                                 | Same, after refreshing repo size and rate-limit headers                                       |
| `getRateLimitInfo()`                              | REST vs raw counters for this instance                                                        |
| `getPendingChanges()`                             | Number of queued local changes                                                                |
| `getLocalDb()`                                    | The [`LocalDB`](docs/api.md#localdb) your UI reads and writes                                 |
| `getApi()`                                        | The underlying `GitHubApiAdapter`                                                             |
| `getConfig()`                                     | Resolved config with all defaults filled in                                                   |
| `isOnline`, `autoSyncRunning`, `autoSyncInterval` | Read-only live properties                                                                     |

### `LocalDB`

The offline-first document store behind `sync.getLocalDb()`. It also works
standalone — no GitHub, no token — which is what the Vue demo's offline mode uses.

| Group            | Methods                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle        | `init()`, `getDeviceId()`, `close()`                                                                                                              |
| Collections      | `registerCollection(name)`, `isCollectionRegistered(name)`, `getRegisteredCollections()`                                                          |
| Reads            | `getDocument()`, `getAllDocuments()`, `getAllDocumentsMap()`, `queryDocuments(predicate)`, `getDocumentCount()`                                   |
| Writes           | `create()`, `updateFields()`, `deleteDocument()`, `restoreDocument()`                                                                             |
| Low-level writes | `putDocument()`, `createDocument()`, `replaceCollection()`, `mergeDocuments()`, `clearCollection()`                                               |
| Changelog queue  | `queueChangelogEntry()`, `getPendingChangelogEntries()`, `getPendingChangelogCount()`, `clearChangelogEntries(ids)`, `clearAllChangelogEntries()` |
| Cursor & meta    | `getSyncCursor()`, `setSyncCursor()`, `clearSyncCursor()`, `getSchemaVersion()`, `setSchemaVersion()`, `getMetaValue()`, `setMetaValue()`         |
| Bulk             | `exportAll()`, `clearAll()`                                                                                                                       |

```typescript
const db = sync.getLocalDb();

// Create — queues a changelog entry, initialises per-field timestamps
await db.create<Todo>('todos', crypto.randomUUID(), { title: 'Write docs', done: false });

// Update only the fields you pass: two devices editing different fields merge cleanly.
// `undefined` removes a field. Returns the updated document, or null if it is gone.
await db.updateFields<Todo>('todos', id, { done: true });

// Soft delete — returns false if it was already deleted, so other devices converge
// instead of resurrecting the row
await db.deleteDocument('todos', id);

const open = await db.queryDocuments<Todo>('todos', (todo) => !todo.done);
```

Every method, its exact semantics and its failure modes:
[`docs/api.md#localdb`](docs/api.md#localdb).

### Merge Algorithms

| Function                                                                  | Description                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| `mergeDocument(localDoc, remoteDoc)`                                      | Field-level LWW merge of two documents            |
| `mergeCollection(localDocs, remoteDocs)`                                  | Merge two id-keyed collection maps                |
| `applyChangelogToCollection(collectionData, changes, deviceId)`           | Apply changelog entries to a collection file      |
| `createDocument(id, data, deviceId, timestamp?)`                          | Create a new `SyncedDocument` with field metadata |
| `createChangelogEntry(collection, docId, op, changedFields?, deletedAt?)` | Create a changelog entry                          |
| `getExpiredDeletes(documents, maxAgeMs)`                                  | Find IDs of expired soft-deletes                  |

### Schema Migration Types

| Type                 | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `MigrationTransform` | Function that transforms a collection's documents during migration        |
| `MigrationStep`      | A single migration step with `from`, `to`, `description`, and `transform` |

### Error Classes

| Class             | Description                             |
| ----------------- | --------------------------------------- |
| `ConflictError`   | GitHub 409 conflict (concurrent pushes) |
| `RateLimitError`  | GitHub API rate limit exceeded          |
| `AuthError`       | Authentication failure (401/403)        |
| `ValidationError` | Invalid input parameters                |

## Repository Structure

When using GitterSync, your GitHub repo will look like:

```
repo/
├── meta.json                              # Schema version, collection SHAs, changelog count
├── collections/
│   ├── users.json                         # Per-collection document store
│   └── posts.json
├── changelog/
│   └── dev-a1b2c3d4-3.json                # One file per device per push
└── files/
    └── task-1/avatar.png                  # Binary attachments (any path works)
```

Locally, the same data lives in two IndexedDB databases: `gittersync`
(changelog queue, sync cursor, device id, meta) and `gittersync_collections`
(one `col_<name>` store per collection).

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Lint
npm run lint

# Run unit tests (320+ tests, excludes integration)
npm test

# Run integration tests (requires GITTERSYNC_TEST_TOKEN)
npm run test:integration

# Build
npm run build

# Watch tests
npm run test:watch

# Check formatting
npm run format:check

# Build / test both demos
npm run build:demos
npm run test:demos
```

### Demo Applications

Both demos import the library from this repository, so build it once first
(`npm run build`).

**Kanban board** ([live](https://srbiz.github.io/gittersync/)) — `demo/`, vanilla
TypeScript + Vite:

```bash
cd demo && npm install
npm run dev            # start dev server
npm run build          # type-check + production build
```

**Todo** ([live](https://srbiz.github.io/gittersync/todo/)) — `demo-vue/`, Vue 3

- Vite + Pinia:

```bash
cd demo-vue && npm install
npm run dev            # start dev server
npm test               # 34 tests: Pinia store + components (jsdom + fake-indexeddb)
npm run build          # vue-tsc + production build
```

The kanban demo's Edit Task dialog, label editor and attachment handling are
covered by `tests/demo-task-detail.test.ts` in the root suite.

### Integration Tests

Integration tests exercise the real GitHub API and require a GitHub Personal Access Token with `repo` and `delete_repo` scopes:

```bash
# PowerShell
$env:GITTERSYNC_TEST_TOKEN = "ghp_your_token_here"
npm run test:integration

# bash/zsh
export GITTERSYNC_TEST_TOKEN="ghp_your_token_here"
npm run test:integration
```

By default a temporary `gittersync-test-*` repository is created and deleted per run. If your token cannot create repositories (GitHub App installations or fine-grained tokens scoped to one repo), point the suite at an existing repository instead — a disposable `gittersync-e2e-*` scratch branch is created off its default branch and deleted afterwards:

```bash
export GITTERSYNC_TEST_TOKEN="ghp_your_token_here"
export GITTERSYNC_TEST_REPO="your-user/your-scratch-repo"
npm run test:integration
```

See [`tests/integration/README.md`](tests/integration/README.md) for details, including the end-to-end flows covered by `tests/integration/e2e.test.ts`.

The most recent full-flow verification run, the defects it uncovered and their fixes are recorded in [`docs/e2e-verification.md`](docs/e2e-verification.md).

## Architecture Plan

See [`plans/github-database-sync-plan-v2.md`](plans/github-database-sync-plan-v2.md) for the full architectural design document covering:

- Sync algorithms and data flow
- GitHub API usage patterns
- Offline-first conflict resolution strategy
- Compaction and repo size management
- Security model (OAuth + encrypted PAT fallback)
- Edge cases and error handling

## License

MIT
