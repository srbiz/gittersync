# GitterSync API Reference

Complete reference for every public export of `gittersync`.

| Audience                                   | Read                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| "I just want my app to sync"               | [Quick start](#quick-start) → [`GitHubSyncService`](#gittersyncservice)                   |
| "I want to read/write data locally"        | [`LocalDB`](#localdb)                                                                     |
| "I keep hitting the GitHub rate limit"     | [Rate-limit budget](#rate-limit-budget) → [Raw content transport](#raw-content-transport) |
| "I need to talk to GitHub myself"          | [`GitHubApiAdapter`](#githubapiadapter)                                                   |
| "I want to understand conflict resolution" | [Merge algorithms](#merge-algorithms) → [Types](#types-reference)                         |

Everything below is exported from the package root:

```ts
import {
    GitHubSyncService,
    LocalDB,
    GitHubApiAdapter,
    RawContentClient,
    resolveConfig,
    storeToken,
    retrieveToken,
    mergeDocument,
    LIBRARY_VERSION,
} from 'gittersync';
import type { SyncedDocument, SyncStatus, SyncResult, Todo } from 'gittersync';
```

The package is ESM-only (`"type": "module"`), ships TypeScript declarations in
`dist/`, and has no Node-specific APIs — it targets browsers (IndexedDB +
`fetch` + Web Crypto). It runs in Node 20+ as long as `indexedDB`, `fetch`,
`crypto.subtle` and `Blob` are available (see
[Testing in Node](#testing-in-node)).

---

## Table of contents

- [Architecture in one page](#architecture-in-one-page)
- [Rate-limit budget](#rate-limit-budget)
- [Quick start](#quick-start)
- [`GitHubSyncService`](#gittersyncservice)
    - [Configuration](#configuration)
    - [Lifecycle](#lifecycle)
    - [Syncing](#syncing)
    - [Status & telemetry](#status--telemetry)
    - [Binary files](#binary-files)
    - [Export & import](#export--import)
- [`LocalDB`](#localdb)
    - [Database layout](#database-layout)
    - [Lifecycle & collections](#lifecycle--collections)
    - [Reading documents](#reading-documents)
    - [Writing documents](#writing-documents)
    - [The changelog queue](#the-changelog-queue)
    - [Cursor, schema version & meta](#cursor-schema-version--meta)
    - [Bulk operations](#bulk-operations)
- [`GitHubApiAdapter`](#githubapiadapter)
- [Raw content transport](#raw-content-transport)
- [Merge algorithms](#merge-algorithms)
- [Token security](#token-security)
- [Configuration helpers & constants](#configuration-helpers--constants)
- [Types reference](#types-reference)
- [Errors](#errors)
- [Recipes](#recipes)
- [Testing in Node](#testing-in-node)
- [Versioning](#versioning)

---

## Architecture in one page

```
GitHub repository (the server)                This device
──────────────────────────────                ──────────────────────────────
collections/<name>.json   ← full state    ⇄   IndexedDB "gittersync_collections"
changelog/<device>-<n>.json ← deltas      ⇄     col_<name> tables (documents)
files/<anything>          ← attachments   ⇄   IndexedDB "gittersync"
meta.json                 ← schema/meta   ⇄     changelog   (pending writes)
                                               sync_cursor, device_id, meta
```

- **Writes are local first.** Every mutation goes to IndexedDB and appends an
  entry to the `changelog` table. Nothing touches the network until you sync.
- **A push uploads the changelog**, not the collections. That is one small file
  per device, so two devices writing at the same time rarely conflict.
- **A pull applies remote changelogs on top of local state**, field by field.
- **Compaction** folds changelogs into the collection files once
  `compactionThreshold` files have accumulated, and purges soft-deletes older
  than `deleteRetentionMs`.
- **Reads prefer `raw.githubusercontent.com`**, which is not part of the REST
  rate limit. See [Raw content transport](#raw-content-transport).

A document on disk looks like this:

```jsonc
{
    "id": "todo-1",
    "data": { "title": "Write docs", "done": false },
    "_fields": {
        "title": { "updatedAt": "2026-11-04T09:12:00.000Z", "device": "dev-a1b2c3" },
        "done": { "updatedAt": "2026-11-04T09:12:00.000Z", "device": "dev-a1b2c3" },
    },
    "updated_at": "2026-11-04T09:12:00.000Z",
    "created_at": "2026-11-04T09:00:00.000Z",
    "deleted_at": null,
    "deleted_by": null,
}
```

`_fields` is what makes merges field-level: `updated_at` is always the **maximum**
timestamp across all fields, and a merge keeps, for each field, whichever copy has
the newer `updatedAt`.

---

## Rate-limit budget

GitHub allows **5,000 REST calls/hour** authenticated (60/hour anonymous). Reads
served by `raw.githubusercontent.com` cost **zero** of that budget, which is why
raw content is on by default.

| Operation                               | REST calls  | Notes                                           |
| --------------------------------------- | ----------- | ----------------------------------------------- |
| `pull()` — first pull of an empty repo  | 0–2         | Directory listings only; installs a cursor      |
| `pull()` — first pull with data         | ~3          | `meta.json` + collection files are raw reads    |
| `pull()` — incremental, nothing changed | 1           | Compare Commits only, **zero** downloads        |
| `pull()` — incremental with changes     | 1 + writes  | Changed files come from raw                     |
| `push()` — nothing pending              | 1           | Directory listing to check compaction           |
| `push()` — with pending changes         | 2–4         | 1–2 per written file (see below)                |
| `sync()`                                | pull + push |                                                 |
| `compact()`                             | 1 per file  | Collection files are read with `forceApi: true` |
| `uploadFile()` / `downloadFile()`       | 1–2 / 0     | Downloads are raw reads                         |
| `listFiles()`                           | 1           | Git Trees API, any depth                        |
| `getStatus()`                           | 0           | Synchronous, reads cached values                |
| `getFullStatus()`                       | 1–2         | Repo size + rate-limit header refresh           |
| `deleteFile()`                          | 1–2         |                                                 |

**Why 1–2 per write?** The Contents API needs the current blob SHA to update a
file. GitterSync caches SHAs it learns from reads and from write responses
(`WriteResult.blobSha`), so the usual case is a single `PUT`. The first write to a
file this instance has never read costs an extra `GET`.

Two rules keep that budget honest:

1. **Never advance the cursor past commits you did not read.** A push only moves
   the cursor when the commit it created has the local cursor among its parents
   (`WriteResult.parentShas`). If another device committed in between, the cursor
   stays put and the next pull picks up both.
2. **Write-critical reads bypass raw.** Compaction rewrites whole files, so it
   passes `{ forceApi: true }` — a CDN-cached copy could resurrect data another
   device just compacted.

Check what you actually spent with
[`getRateLimitInfo()`](#getratelimitinfo-ratelimitinfo).

---

## Quick start

```ts
import { GitHubSyncService, storeToken, retrieveToken } from 'gittersync';

interface Todo {
    title: string;
    done: boolean;
}

// 1. Encrypt the token before it ever reaches localStorage
const passphrase = 'a passphrase only this user knows';
await storeToken(process.env.GITHUB_TOKEN!, passphrase);
const token = (await retrieveToken(passphrase))!;

// 2. Create the service
const sync = new GitHubSyncService({
    owner: 'your-name',
    repo: 'your-data-repo',
    branch: 'main',
    onSyncStatusChange: (status) => renderStatusBadge(status),
});

// 3. Initialise and declare the collections the app uses
await sync.init(token);
await sync.registerCollections(['todos']);

// 4. Read and write through the local database — no network here
const db = sync.getLocalDb();
await db.create<Todo>('todos', crypto.randomUUID(), { title: 'Write docs', done: false });

const open = await db.queryDocuments<Todo>('todos', (todo) => !todo.done);
await db.updateFields<Todo>('todos', open[0].id, { done: true });

// 5. Sync when you like (or let auto-sync do it)
const result = await sync.sync();
if (result.type !== 'none') {
    console.log(`pushed ${result.pushed}, merged ${result.documentsMerged} documents`);
}

sync.startAutoSync(30_000);

// 6. Always tear down when the view goes away
window.addEventListener('pagehide', () => void sync.destroy());
```

---

## `GitHubSyncService`

The orchestrator. One instance per repository per device.

```ts
const sync = new GitHubSyncService(config);
```

The constructor validates the config eagerly (`resolveConfig`) and creates the
`LocalDB` and `GitHubApiAdapter`, but performs **no I/O**. Nothing happens until
`init()`.

### Configuration

`GitHubSyncConfig` — every field except `owner` and `repo` is optional.

| Field                 | Type                           | Default                               | Description                                                                                                                                                |
| --------------------- | ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`               | `string`                       | —                                     | Repository owner (user or org). **Required.**                                                                                                              |
| `repo`                | `string`                       | —                                     | Repository name. **Required.**                                                                                                                             |
| `branch`              | `string`                       | `'main'`                              | Branch used for reads and writes.                                                                                                                          |
| `useRawContent`       | `boolean`                      | `true`                                | Serve reads from `raw.githubusercontent.com` (free of the REST rate limit). See [Raw content transport](#raw-content-transport).                           |
| `rawBaseUrl`          | `string`                       | `'https://raw.githubusercontent.com'` | Override for proxies or GitHub Enterprise.                                                                                                                 |
| `rawCacheBust`        | `boolean`                      | `true`                                | Append a cache-busting query parameter to raw URLs. Turn off only if you front raw with your own cache.                                                    |
| `requestTimeoutMs`    | `number`                       | `30_000`                              | Per-request timeout for raw **and** REST calls.                                                                                                            |
| `compactionThreshold` | `number`                       | `20`                                  | Number of remote changelog files that triggers compaction during a push.                                                                                   |
| `maxRetries`          | `number`                       | `3`                                   | Attempts per write on HTTP 409, and per `sync()` cycle on `ConflictError`.                                                                                 |
| `retryBaseDelay`      | `number`                       | `1_000`                               | Base delay (ms) for exponential backoff: `retryBaseDelay * attempt`.                                                                                       |
| `deleteRetentionMs`   | `number`                       | `2_592_000_000` (30 days)             | How long soft-deleted documents survive before compaction purges them. Purging too early can resurrect deletes on devices that have not synced in a while. |
| `onSyncStatusChange`  | `(status: SyncStatus) => void` | no-op                                 | Called on every state change: init, sync start/end, auto-sync ticks, rate-limit pauses.                                                                    |
| `migrations`          | `MigrationStep[]`              | `[]`                                  | Run during a pull when the remote `schemaVersion` is newer than the local one.                                                                             |

Invalid values throw `ValidationError` from the constructor (negative numbers,
non-string owner/repo, …). Read back the resolved object with
[`getConfig()`](#getconfig-readonlyresolvedgithubsyncconfig).

### Lifecycle

#### `init(token: string): Promise<boolean>`

Authenticates the adapter, opens IndexedDB, creates/loads this device's id and
refreshes the cached status. Returns `true` on success; throws `AuthError` for a
rejected token and `ValidationError` for an empty one.

Idempotent per instance, but you must call it before any other method —
everything else throws `Error('Not initialized')` otherwise.

#### `registerCollections(names: string[]): Promise<void>`

Declares the collections this app uses. Each name becomes
`collections/<name>.json` in the repository and an IndexedDB table locally.
Must run after `init()` and before the first read or write on those collections.
Calling it twice is a no-op.

Names must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — otherwise
`ValidationError`. A `pull()` auto-registers any collection it discovers
remotely, so you only need to declare the ones _you_ write to.

```ts
await sync.registerCollections(['todos', 'settings']);
```

#### `destroy(): Promise<void>`

Stops auto-sync, removes the `online`/`offline` listeners and closes the local
database. Call this when the view that owns the service goes away — otherwise
the listeners leak and the IndexedDB connection stays open (which also blocks
`indexedDB.deleteDatabase` in tests).

#### `reset(): Promise<void>`

Wipes local state: all collections, the changelog queue, the cursor and meta
values — but **not** this device's id, and **not** anything on GitHub. The next
`pull()` is a full pull. Use it for "forget this device" flows.

```ts
await sync.reset();
await sync.pull();
```

### Syncing

All four operations are serialised: they take a lock, and a call that arrives
while another is running waits for it rather than interleaving writes.

#### `pull(): Promise<PullResult>`

Brings local state up to date with the repository.

- **No cursor yet** → full pull: read `meta.json`, list `changelog/`, download
  every collection file, then apply changelogs on top. Installs a cursor at the
  end, even for an empty repository (so the next pull is incremental).
- **Cursor present** → Compare Commits decides which files changed; only those
  are downloaded. `status: 'identical'` returns `{ type: 'none' }` with **zero**
  downloads.
- **Cursor unresolvable** (force-push, history rewrite, rollback) → the cursor is
  discarded and a full pull runs, so remote changes are never silently skipped.
- Compare results truncated by GitHub (250 commits / 300 files) are treated as
  `diverged`, which also degrades to a full pull.

```ts
const result = await sync.pull();
switch (result.type) {
    case 'none':
        break; // already up to date
    case 'full':
        console.log(Object.keys(result.collections), result.documentsMerged, result.changelogOps);
        break;
    case 'incremental':
        console.log(result.changelogs.length, result.documentsMerged, result.changelogOps);
        break;
}
```

#### `push(): Promise<PushResult>`

Uploads pending changelog entries as one new `changelog/<deviceId>-<n>.json`
file, then compacts if the remote changelog count reached `compactionThreshold`.

```ts
const result = await sync.push();
// { pushed: 3, changelogPath: 'changelog/dev-a1b2c3-4.json', compacted: false, apiCalls: 2, rawReads: 1 }
```

`pushed: 0` and `changelogPath: null` mean this device had nothing pending —
no file is written.

**Cursor safety.** A push only advances the local cursor when the commit it
created lists the current cursor among its parents. If a different device
committed in between, the cursor stays where it was and the next `pull()` fetches
both sets of changes. A device that has never pulled does not get a cursor from a
push at all — installing one would mark remote history as "already seen".

#### `sync(): Promise<SyncResult>`

`pull()` then `push()`, retried as a whole on `ConflictError` up to `maxRetries`
times (bounded — a permanently conflicting repository surfaces an error instead
of spinning). Returns the pull outcome plus `pushed`.

```ts
const result = await sync.sync();
if (result.type === 'none') {
    console.log(result.pushed > 0 ? `pushed ${result.pushed}` : 'in sync');
} else {
    console.log(`pushed ${result.pushed}, merged ${result.documentsMerged} docs`);
}
```

If another operation is already running, `sync()` logs a warning and returns
`{ type: 'none', pushed: 0 }` instead of queueing behind it.

#### `compact(): Promise<CompactionResult>`

Folds every remote changelog into the collection files, purges soft-deletes older
than `deleteRetentionMs`, deletes the applied changelog files and rewrites
`meta.json`. Pushes call this automatically at `compactionThreshold`; call it
yourself for maintenance UIs.

```ts
const result = await sync.compact();
// { changelogsCompacted: 21, collectionsWritten: ['todos'], purgedDeletes: 4, apiCalls: 24 }
```

Collection files are read with `{ forceApi: true }` here, because a compaction
rewrites them wholesale.

#### `startAutoSync(intervalMs = 300_000): void` / `stopAutoSync(): void`

Runs `sync()` on an interval. Behaviour:

- The interval is clamped to a **1,000 ms floor** (`autoSyncInterval` reports the
  effective value).
- Cycles are skipped while `navigator.onLine` is `false`, and an immediate sync
  runs when connectivity returns.
- A `RateLimitError` pauses cycles until `resetAt` and warns **once** per pause
  (a message containing `paused until`), instead of logging every tick.
- Overlapping cycles are skipped, never queued.
- The first cycle runs immediately if online.

```ts
sync.startAutoSync(30_000);
sync.autoSyncRunning; // true
sync.autoSyncInterval; // 30000
sync.stopAutoSync();
```

### Status & telemetry

#### `getStatus(): SyncStatus`

Synchronous, **zero** REST calls — returns the values cached by the last
operation. This is what `onSyncStatusChange` pushes, so a UI can render from
either.

```ts
const status = sync.getStatus();
// {
//   isSyncing: false, isOnline: true, isInitialized: true,
//   lastSyncAt: '2026-11-04T09:30:00.000Z',
//   cursor: { sha: '9f1c…', timestamp: '…' },
//   deviceId: 'dev-a1b2c3', pendingChanges: 2,
//   repoSizeKb: 148, rateLimitRemaining: 4987,
//   rateLimitResetAt: '2026-11-04T10:00:00.000Z',
//   rawContentActive: true
// }
```

#### `getFullStatus(): Promise<SyncStatus>`

Same shape, but refreshes the repository size and the rate-limit headers from
GitHub first (1–2 REST calls). Use it for a "details" panel, not in a render loop.

#### `getRateLimitInfo(): RateLimitInfo`

Transport-level counters for this instance, with no network I/O:

```ts
const info = sync.getRateLimitInfo();
// { remaining: 4987, resetAt: '…', apiCalls: 13,
//   rawReads: 41, rawMisses: 2, rawFallbacks: 0, rawContentActive: true }
```

`rawReads + rawMisses` is the number of reads that cost nothing — a useful thing
to show users of a repository-backed app.

#### `getPendingChanges(): Promise<number>`

Number of changelog entries waiting to be pushed.

#### `getConfig(): Readonly<ResolvedGitHubSyncConfig>`

The validated config with every default filled in.

#### `getLocalDb(): LocalDB` / `getApi(): GitHubApiAdapter`

Escape hatches to the two collaborators. `getLocalDb()` is the normal way an app
reads and writes data; see [`LocalDB`](#localdb).

#### `get isOnline(): boolean` / `get autoSyncRunning(): boolean` / `get autoSyncInterval(): number`

Live flags maintained by the service's own `online`/`offline` listeners.

### Binary files

Attachments live under `files/` by convention, but any valid repository path
works. Paths are validated on every entry point: no leading `/`, no `..`, no
backslashes, no empty segments, no control characters — `ValidationError`
otherwise.

#### `uploadFile(filePath, content, message?, mimeType?): Promise<FileRef>`

```ts
async uploadFile(
    filePath: string,
    content: UploadableContent, // string | Blob | ArrayBuffer | Uint8Array
    message?: string,           // defaults to `Upload <filename>`
    mimeType?: string,          // inferred from the extension otherwise
): Promise<FileRef>
```

Accepts a `File`/`Blob` directly (no manual base64), a base64 string, a
`data:` URL, an `ArrayBuffer` or a `Uint8Array`. Size is checked against
GitHub's **1 MiB** Contents API limit (`MAX_CONTENT_API_BYTES`) before any
network call, with base64 padding accounted for, and throws `ValidationError`
when exceeded.

```ts
const ref = await sync.uploadFile(`files/${task.id}/${file.name}`, file);
// { path: 'files/task-1/spec.pdf', sha: 'a1b2…', size: 184320, mimeType: 'application/pdf' }

await db.updateFields('tasks', task.id, {
    attachments: [...(task.data.attachments ?? []), ref],
});
```

Store the returned `FileRef` inside a document — that is the whole attachment
model. Downloads then work offline-first through `downloadFile()`.

#### `downloadFile(filePath, options?): Promise<Blob>`

Raw read when possible (0 REST calls); `{ forceApi: true }` forces the Contents
API. Throws if the file does not exist.

```ts
const blob = await sync.downloadFile(ref.path);
const url = URL.createObjectURL(blob);
// remember to URL.revokeObjectURL(url) when the element goes away
```

#### `deleteFile(filePath, message?): Promise<void>`

Deletes a file; silently succeeds when it is already gone.

#### `listFiles(dir = 'files'): Promise<string[]>`

Recursive listing through the Git Trees API — **1 REST call regardless of
depth**. Returns paths relative to the repository root.

### Export & import

#### `exportData(): Promise<Blob>`

Downloads the whole repository (`meta.json`, every collection, every changelog,
and everything under `files/`, recursively) and returns a ZIP:

```
manifest.json
meta.json
collections/<name>.json
changelog/<file>.json
files/<path>
```

#### `importData(file: File | Blob): Promise<void>`

Parses and validates a ZIP produced by `exportData()`, **replaces** local
collection data, clears the sync cursor (so the next pull is a full pull) and
adopts the schema version from `manifest.json`. Throws `ValidationError` on a
malformed or foreign archive.

```ts
const zip = await sync.exportData();
// … user downloads it …
await sync.importData(pickedFile);
await sync.pull();
```

---

## `LocalDB`

The offline-first document store. This is the API your UI should read and write
against: every call is local, synchronous-latency, and journalled so the sync
engine can replay it later.

```ts
import { LocalDB } from 'gittersync';

// Normally you get it from the service:
const db = sync.getLocalDb();

// …but it also stands alone — a repository is optional:
const local = new LocalDB();
await local.init();
await local.registerCollection('todos');
```

> **Standalone mode is a supported use case.** `LocalDB` has no GitHub
> dependency: it is IndexedDB plus a changelog queue. An app can ship
> local-only and add syncing later by handing the same collection names to a
> `GitHubSyncService` (the Vue todo demo's "Try it offline" button does exactly
> this).

All methods reject with `Error('Database not initialized')` before `init()`, and
with `Error('Collection "x" not registered')` when the collection was never
registered.

### Database layout

Two IndexedDB databases, so schema changes to collections never force a version
bump on the metadata store:

| Constant              | Database                   | Object stores                                                   |
| --------------------- | -------------------------- | --------------------------------------------------------------- |
| `META_DB_NAME`        | `'gittersync'`             | `changelog` (`++localId`), `sync_cursor`, `device_info`, `meta` |
| `COLLECTIONS_DB_NAME` | `'gittersync_collections'` | one `col_<name>` store per collection (`id` primary key)        |

```ts
import { LocalDB, META_DB_NAME, COLLECTIONS_DB_NAME } from 'gittersync';
```

Supporting types:

```ts
/** A queued changelog entry, as stored locally. */
interface LocalChangelogEntry extends ChangelogEntry {
    localId?: number; // IndexedDB auto-increment key
    queuedAt: string; // when this device queued it
    deviceId: DeviceId;
}

/** A key/value row in the meta store. */
interface SyncMeta {
    key: string;
    value: string;
}
```

### Lifecycle & collections

#### `init(): Promise<DeviceId>`

Opens both databases, creates them if needed, and returns this device's stable
identifier (created once, stored under `device_info`, reused forever). Safe to
call repeatedly — concurrent calls share one promise, so `await db.init()` twice
returns the same id without reopening anything.

```ts
const deviceId = await db.init(); // 'dev-a1b2c3d4'
```

#### `getDeviceId(): DeviceId`

The id from `init()` without touching IndexedDB. Empty string before `init()`.

#### `registerCollection(name: string): Promise<void>`

Creates the `col_<name>` store if it does not exist yet.

What makes this safe to call on every app start:

1. The name is validated against `COLLECTION_NAME_PATTERN`
   (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`) — `ValidationError` otherwise. This
   is also what keeps a collection name from escaping into a store name or a
   repository path.
2. The **native** IndexedDB schema is discovered by opening the database with
   `indexedDB.open(name)` (no version argument) and reading
   `db.objectStoreNames` / `db.version`. A fresh Dexie instance reports
   `tables: []`, so re-declaring only _this_ session's collections would hide
   stores created earlier — real browsers answer that with `VersionError`.
3. Every existing `col_*` store is re-declared alongside the new one, at
   `max(currentVersion, ceil(nativeVersion / 10)) + 1`, and the previous
   connection is closed **before** the version bump.

Registering an already-registered collection is a no-op.

```ts
await db.registerCollection('todos');
db.isCollectionRegistered('todos'); // true
```

#### `isCollectionRegistered(name: string): boolean`

Synchronous membership check.

#### `getRegisteredCollections(): string[]`

Every collection this instance knows about, including ones discovered from the
native schema rather than registered by this session.

### Reading documents

Every read returns `SyncedDocument<T>` — your data in `.data`, sync metadata in
`_fields`/`updated_at`/`created_at`/`deleted_at`. Pass your app's type as the
generic parameter:

```ts
interface Todo {
    title: string;
    done: boolean;
}

const doc = await db.getDocument<Todo>('todos', id);
doc?.data.title;
```

#### `getDocument<T>(collection, docId): Promise<SyncedDocument<T> | undefined>`

One document by id, **including** soft-deleted ones (check `deleted_at`).
`undefined` when absent.

#### `getAllDocuments<T>(collection, includeDeleted = false): Promise<SyncedDocument<T>[]>`

Whole collection. Soft-deleted documents are filtered out unless
`includeDeleted` is `true`.

#### `getAllDocumentsMap<T>(collection, includeDeleted = false): Promise<Record<string, SyncedDocument<T>>>`

Same data keyed by document id — the shape collection files use, which makes it
handy for diffs and for `mergeDocuments`.

#### `queryDocuments<T>(collection, predicate, includeDeleted = false): Promise<SyncedDocument<T>[]>`

```ts
await db.queryDocuments<Todo>('todos', (data, doc) => !data.done && doc.updated_at > cutoff);
```

The predicate receives `(data, doc)` and runs in the browser, not in IndexedDB —
there are no secondary indexes, so this is a filtered full scan. Fine for
document-scale collections (hundreds to low thousands); keep hot filters narrow
or index yourself if you go far beyond that.

#### `getDocumentCount(collection, includeDeleted = false): Promise<number>`

Count without materialising the documents.

### Writing documents

There are two tiers. **Use the first tier in app code** — it maintains `_fields`,
timestamps and the changelog queue for you.

| Method                                     | Queues a changelog entry? | Use when                                                                       |
| ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------ |
| `create()`                                 | yes                       | New document from app code                                                     |
| `updateFields()`                           | yes                       | Editing some fields of an existing document                                    |
| `deleteDocument()`                         | yes                       | Removing a document (soft delete)                                              |
| `restoreDocument()`                        | yes                       | Undoing a delete                                                               |
| `putDocument()` / `createDocument()`       | by default                | You built the whole `SyncedDocument` yourself (sync internals, imports, tests) |
| `replaceCollection()` / `mergeDocuments()` | no                        | Bulk-applying remote state (sync internals, imports)                           |
| `clearCollection()` / `clearAll()`         | no                        | Wiping local data                                                              |

#### `create<T>(collection, id, data, timestamp?): Promise<SyncedDocument<T>>`

Inserts a new document with `_fields` initialised for every key in `data`.

```ts
const doc = await db.create<Todo>('todos', crypto.randomUUID(), {
    title: 'Write docs',
    done: false,
});
```

Throws `ValidationError` when `id` is empty, when `data` is not a plain object,
or when a document with that id **already exists** (including soft-deleted ones —
use `restoreDocument` for those). `timestamp` overrides `created_at`/`updated_at`
(ISO 8601), which is how imports preserve original times.

#### `updateFields<T>(collection, docId, changes, timestamp?): Promise<SyncedDocument<T> | null>`

The workhorse. Updates only the fields you pass, stamps each one with
`{ updatedAt: timestamp, device: deviceId }`, refreshes `updated_at` and queues
**one** changelog entry carrying just those fields.

```ts
await db.updateFields<Todo>('todos', id, { done: true });

// `undefined` removes a field from the document
await db.updateFields<Todo>('todos', id, { dueDate: undefined });
```

Returns the updated document, or `null` when the id does not exist (nothing is
queued in that case).

Two semantics worth knowing:

- **`updated_at` is the maximum timestamp across all fields**, so passing an
  _older_ explicit `timestamp` does not lower it. That is deliberate: it keeps
  "newest field wins" merges monotonic.
- Because the changelog entry carries only the changed fields, two devices
  editing _different_ fields of the same document merge without a conflict.

#### `deleteDocument(collection, docId): Promise<boolean>`

Soft delete: sets `deleted_at`/`deleted_by` and queues a `delete` changelog
entry. Returns `true` when it deleted something, `false` when the document was
absent **or already deleted** (idempotent).

Documents are kept, not removed, so other devices learn about the deletion
instead of resurrecting the row on their next pull. Compaction purges them once
they are older than `deleteRetentionMs`.

#### `restoreDocument<T>(collection, docId): Promise<SyncedDocument<T> | null>`

Clears `deleted_at`/`deleted_by`, stamps the change and queues an `update` entry
(so the restore propagates). Returns the restored document, or `null` when the id
does not exist. Restoring a document that was not deleted is a no-op that returns
it unchanged.

#### `putDocument<T>(collection, doc, queueChangelog = true): Promise<void>`

Upsert a complete `SyncedDocument` you built yourself. `createDocument` is the
`add` variant — it **throws** on a duplicate key instead of overwriting.

Both queue a changelog entry by default; the sync engine passes `false` when
applying _remote_ state, because a remote change must not be echoed back.

```ts
await db.putDocument('todos', mergedDoc, false); // applying a remote merge
```

#### `replaceCollection<T>(collection, documents): Promise<void>`

Atomically clears the store and bulk-writes `documents` (a
`Record<id, SyncedDocument<T>>`) in one transaction. **Does not** queue changelog
entries — it is how a full pull installs remote state.

#### `mergeDocuments<T>(collection, documents, mergeFn): Promise<number>`

Applies remote documents one by one through your merge function, in a single
transaction, and returns how many local documents changed.

```ts
const updated = await db.mergeDocuments('todos', remoteDocs, (local, remote) =>
    mergeDocument(local, remote),
);
```

Existing ids go through `mergeFn`; unknown ids are inserted as-is; nothing is
queued (remote data must not be re-pushed).

#### `clearCollection(collection): Promise<void>`

Empties one store. No changelog entries — this is a local-only wipe (used by
`reset()` and by import).

### The changelog queue

The queue is the write-ahead log that `push()` uploads. App code rarely touches
it, but it is public so you can build "N unsynced changes" UIs and repair tools.

#### `queueChangelogEntry(entry: ChangelogEntry): Promise<void>`

Appends an entry, stamping `queuedAt` and `deviceId`. `create`, `updateFields`,
`deleteDocument` and `restoreDocument` call this for you — call it directly only
when you also wrote the document with `queueChangelog = false`.

#### `getPendingChangelogEntries(): Promise<LocalChangelogEntry[]>`

Everything waiting to be pushed, in **FIFO order** (by `queuedAt`, ties broken by
`localId`). Order matters: a `create` must reach GitHub before the `update` that
follows it.

#### `getPendingChangelogCount(): Promise<number>`

Cheap count for a badge. (`SyncStatus.pendingChanges` is the same number, cached.)

#### `clearChangelogEntries(localIds: number[]): Promise<void>`

Removes exactly the entries a successful push uploaded. The sync engine captures
the ids **before** the network call and clears **those**, so entries queued while
the push was in flight survive.

#### `clearAllChangelogEntries(): Promise<void>`

Drops the whole queue (`reset()`, import). Local documents are untouched.

### Cursor, schema version & meta

#### `getSyncCursor(): Promise<SyncCursor | null>`

The commit this device last reconciled with: `{ sha, timestamp }`, or `null` when
it has never pulled. Self-healing: a corrupt or unparseable stored value is
cleared and reported as `null` rather than throwing, so a damaged cursor costs a
full pull instead of a broken app.

#### `setSyncCursor(cursor: SyncCursor): Promise<void>` / `clearSyncCursor(): Promise<void>`

Install or discard the cursor. Clearing forces the next `pull()` to be a full
pull — the safe recovery move after any doubt about what has been seen.

#### `getSchemaVersion(): Promise<number>` / `setSchemaVersion(version: number): Promise<void>`

The schema version this device's data is at (default `1`). `pull()` compares it
with `meta.json` and runs your `migrations` when the remote version is newer.

#### `getMetaValue(key: string): Promise<string | null>` / `setMetaValue(key: string, value: string): Promise<void>`

Small key/value store for app-level bookkeeping that should not live in a synced
collection (last compaction time, feature flags, a cached repo size, …). Values
are strings; serialise anything else yourself.

### Bulk operations

#### `exportAll(): Promise<Record<string, Record<string, SyncedDocument>>>`

Every registered collection as `{ collection: { id: document } }`, soft-deleted
documents included. This is what `exportData()` zips.

#### `clearAll(): Promise<void>`

Wipes all collection stores, the changelog queue and the meta values — but keeps
the device id, so this device remains distinguishable after a reset.

#### `close(): Promise<void>`

Closes both Dexie connections. Call it before deleting the databases (in tests,
or when tearing a session down); an open connection makes
`indexedDB.deleteDatabase` block indefinitely.

#### `getMetaDatabase()` / `getCollectionsDatabase()`

The underlying Dexie instances (`GitterSyncDB` / `CollectionsDB`, both Dexie
subclasses). Use them for transactions or indexes GitterSync does not expose —
but write through the tier-1 methods, or your changes will not be queued for
sync.

```ts
await db.getCollectionsDatabase().transaction('rw', 'col_todos', async () => {
    /* … */
});
```

---

## `GitHubApiAdapter`

The GitHub transport. `GitHubSyncService` owns one; use it directly when you need
repository operations GitterSync does not wrap.

```ts
import { GitHubApiAdapter } from 'gittersync';

const api = new GitHubApiAdapter({ owner: 'me', repo: 'my-data', branch: 'main' });
await api.init(token);
```

#### `init(token: string): Promise<boolean>`

Authenticates, reads the repository (`GET /repos/{owner}/{repo}`) to verify the
token and learn whether the repository is private, then primes the raw client.
Throws `ValidationError` for an empty token and `AuthError` for a rejected one.
Captures the rate-limit headers from the response.

**Cost:** 1 REST call.

#### Reads

| Method                               | Returns                            | Cost          |
| ------------------------------------ | ---------------------------------- | ------------- |
| `fetchJsonFile<T>(path, options?)`   | `GitHubFileResult<T> \| null`      | 0 (raw) or 1  |
| `fetchTextFile(path, options?)`      | `GitHubFileResult<string> \| null` | 0 (raw) or 1  |
| `downloadBinaryFile(path, options?)` | `Blob`                             | 0 (raw) or 1  |
| `listDirectory(path)`                | `string[]` (filenames)             | 1             |
| `listDirectoryRecursive(path)`       | `string[]` (paths)                 | 1 (Git Trees) |
| `getLatestCommitSha()`               | `string`                           | 1             |
| `compareCommits(baseSha)`            | `CompareResult`                    | 1             |
| `getRepoSize()`                      | `number` (KB)                      | 1             |

`fetchJsonFile` returns `null` for a missing file, and throws for content that is
not valid JSON (the parse failure is classified like any other read error) — a
corrupt file is loud rather than silently empty. It throws `ValidationError` when
the path resolves to a directory instead of a file. A missing directory lists as
`[]`, not an error.

Every read is classified: 401/403 → `AuthError`, an exhausted budget →
`RateLimitError`, 409 → `ConflictError`, anything else → a plain `Error` with a
`Failed to read <path>` context message.

```ts
const result = await api.fetchJsonFile<CollectionFile>('collections/todos.json');
if (result) {
    result.content; // parsed JSON
    result.source; // 'raw' | 'api'
    result.sha; // blob SHA, or '' when served by raw
}
```

`options.forceApi` bypasses raw for this one read — required for write-critical
reads (see [Raw content transport](#raw-content-transport)).

#### Writes

| Method                                                | Returns       | Cost                                         |
| ----------------------------------------------------- | ------------- | -------------------------------------------- |
| `writeFile(path, content, message)`                   | `WriteResult` | 1–2 per attempt, up to `maxRetries` attempts |
| `createOrUpdateFile(path, content, message)`          | blob SHA      | 1–2                                          |
| `createOrUpdateFileWithRetry(path, content, message)` | blob SHA      | 1–2 per attempt                              |
| `uploadBinaryFile(path, base64Content, message)`      | blob SHA      | 1–2                                          |
| `deleteFile(path, message)`                           | `void`        | 1–2                                          |

Prefer `writeFile`: it retries on HTTP 409 (dropping the stale cached SHA between
attempts), classifies errors into `ConflictError` / `RateLimitError` / `AuthError`,
and returns the commit metadata the cursor logic depends on.

```ts
const written = await api.writeFile('notes.md', '# Hi', 'Update notes');
// { path: 'notes.md', blobSha: 'a1b2…', commitSha: '9f1c…', parentShas: ['4d5e…'] }
```

`deleteFile` succeeds silently when the file is already gone, and retries once
when a cached SHA turned out to be stale.

#### `compareCommits(baseSha): Promise<CompareResult>`

```ts
interface CompareResult {
    status: string; // 'identical' | 'ahead' | 'behind' | 'diverged'
    changedFiles: string[];
    headSha: string;
    aheadBy: number;
    behindBy: number;
}
```

`headSha` comes from the compare payload itself when GitHub reports `ahead` or
`identical`, which saves a `listCommits` call. Rules worth knowing:

- `headSha` is never `merge_base_commit.sha` — that would move the cursor
  backwards. It is the newest commit in the response, `''` when unknown, and
  `baseSha` when `identical`.
- A 404 (unknown base SHA after a force-push) is reported as `diverged` with no
  changed files, so callers fall back to a full pull instead of skipping data.
- GitHub truncates compares at **250 commits / 300 files**
  (`COMPARE_COMMIT_LIMIT` / `COMPARE_FILE_LIMIT`). A truncated result is reported
  as `diverged` for the same reason.

#### Telemetry & state

| Member                                                                | Description                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `getUsage(): ApiUsage`                                                | `{ apiCalls, rawReads, rawMisses, rawFallbacks }` since the last reset             |
| `resetUsage(): void`                                                  | Zeroes both the REST counter and the raw stats                                     |
| `get rawContentActive(): boolean`                                     | Whether raw reads are enabled **and** currently usable                             |
| `getLastCommit(): { sha, parentShas } \| null`                        | Commit metadata from the most recent write — how a push detects concurrent commits |
| `getCachedRepoSize(): number \| null`                                 | Repo size in KB from the last `getRepoSize()`                                      |
| `get repoIsPrivate(): boolean \| null`                                | `null` before `init()`                                                             |
| `rateLimitRemaining: number \| null`                                  | From the last response's `x-ratelimit-remaining` header                            |
| `rateLimitResetAt: Date \| null`                                      | From `x-ratelimit-reset`                                                           |
| `clearShaCache(): void`                                               | Drops cached blob SHAs (forces a `GET` before the next write)                      |
| `get owner / repo / branch / compactionThreshold / deleteRetentionMs` | Resolved config                                                                    |

**Budget guard.** Writes check the remaining budget before spending a call: with
`rateLimitRemaining === 0` they throw `RateLimitError(resetAt, remaining)`
immediately, and below 100 remaining they warn. Reads never throw for budget
reasons — a raw read costs nothing.

---

## Raw content transport

`raw.githubusercontent.com` serves committed file content over a CDN and is
**not** part of the REST rate limit. GitterSync uses it for every read it can,
which is the single biggest saving when a repository is your database.

```
GET https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}?cb=<random>
```

### What it changes

|               | REST Contents API        | raw                                   |
| ------------- | ------------------------ | ------------------------------------- |
| Rate limit    | 5,000/hour authenticated | Not metered                           |
| Blob SHA      | Returned                 | **Not available** (`sha: ''`)         |
| Freshness     | Authoritative            | CDN-cached, up to ~5 minutes stale    |
| Private repos | Works with a token       | Works only when the token can be sent |
| Missing file  | 404                      | 404                                   |

### Fallback rules

A raw read is used only when it can be trusted. The client falls back to the REST
API when:

- raw content is disabled (`useRawContent: false`) or was disabled at runtime;
- the response is not `200` **and** not a definitive `404`;
- the payload fails to parse (JSON reads);
- a network/CORS error occurs;
- the repository is private and the token cannot be used for raw reads —
  an _anonymous_ 404 on a private repo would otherwise look like "file does not
  exist" and cause silent data loss, so it is treated as `unavailable`, never as
  `missing`.

Each fallback is counted (`ApiUsage.rawFallbacks`) and the reason is logged once,
so a permanently broken raw channel is visible instead of quietly doubling your
API usage.

### Configuration

| Option             | Default                             | Notes                                                                                                 |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `useRawContent`    | `true`                              | Master switch. Set `false` if you need read-after-write consistency from the REST API for every read. |
| `rawBaseUrl`       | `https://raw.githubusercontent.com` | Point at a proxy or GitHub Enterprise raw host.                                                       |
| `rawCacheBust`     | `true`                              | Appends `?cb=<random>` to defeat CDN caching. Turn off only behind your own cache.                    |
| `requestTimeoutMs` | `30_000`                            | Abort per request.                                                                                    |

`FetchFileOptions.forceApi` overrides all of this for a single read:

```ts
// Write-critical: a compaction is about to rewrite this whole file, so a
// CDN-cached copy could resurrect data another device just compacted.
const current = await api.fetchJsonFile<CollectionFile>(path, { forceApi: true });
```

GitterSync already passes `forceApi: true` where it matters (compaction, and the
`meta.json` read whose blob SHA has to be recorded).

### `RawContentClient` (advanced)

Exported for apps that want the same transport for their own paths.

```ts
import { RawContentClient } from 'gittersync';

const raw = new RawContentClient({ owner: 'me', repo: 'data', ref: 'main', token });

raw.available(); // false once disabled
raw.urlFor('collections/todos.json'); // full URL, cache-busted

const outcome = await raw.fetchText('collections/todos.json');
switch (outcome.status) {
    case 'ok':
        outcome.value; // string
        break;
    case 'missing':
        break; // definitive 404
    case 'unavailable':
        outcome.reason; // why the REST fallback is needed
        break;
}

const blob = await raw.fetchBlob('files/task-1/photo.png');
raw.getStats(); // { hits, misses, fallbacks, bytes }
raw.requestsSaved(); // hits + misses
raw.setToken(token);
raw.setRepoVisibility(false);
raw.disable('cors-blocked');
raw.resetStats();
```

```ts
type RawFetchOutcome<T> =
    { status: 'ok'; value: T } | { status: 'missing' } | { status: 'unavailable'; reason: string };

interface RawContentConfig {
    owner: string;
    repo: string;
    ref: string;
    token?: string | null;
    baseUrl?: string;
    cacheBust?: boolean;
    timeoutMs?: number;
}

interface RawContentStats {
    hits: number;
    misses: number;
    fallbacks: number;
    bytes: number;
}
```

> **Do not send `Authorization: Bearer` to raw for public repositories.** It
> breaks CORS for cross-origin browser requests. The client only authenticates
> raw reads when the repository is known to be private.

---

## Merge algorithms

Pure functions, no I/O — the conflict-resolution core. Exported so you can build
custom sync flows or test your own merge policies.

#### `mergeDocument<T>(localDoc, remoteDoc): SyncedDocument<T>`

Field-level three-way-ish merge. For each field present in either document, the
copy with the newer `_fields[name].updatedAt` wins; a field missing from one side
is kept from the other. `deleted_at` is resolved by timestamp too, so a delete
beats an older edit and an edit beats an older delete. The result's `updated_at`
is the maximum field timestamp.

```ts
const merged = mergeDocument(localTodo, remoteTodo);
```

#### `mergeCollection<T>(localDocs, remoteDocs): Record<string, SyncedDocument<T>>`

`mergeDocument` across two id-keyed maps, keeping documents that exist on only
one side.

#### `applyChangelogToCollection<T>(collectionData, changes, deviceId): CollectionFile<T>`

Applies `create` / `update` / `delete` changelog entries to a collection file —
the server-side half of compaction, usable on its own:

```ts
const next = applyChangelogToCollection(collectionFile, changelog.changes, changelog.deviceId);
```

`update` entries apply only the fields they carry, and only when the entry's
timestamp is newer than the local field's.

#### `createDocument<T>(id, data, deviceId, timestamp?): SyncedDocument<T>`

Builds a well-formed document with `_fields` initialised for every key in `data`.

#### `createChangelogEntry(collection, docId, op, changedFields?, deletedAt?): ChangelogEntry`

```ts
createChangelogEntry('todos', id, 'update', {
    done: { value: true, updatedAt: new Date().toISOString() },
});
```

#### `getExpiredDeletes<T>(documents, maxAgeMs): string[]`

Ids of soft-deleted documents older than `maxAgeMs` — what compaction purges.

---

## Token security

A GitHub PAT can write to your repositories, so it is encrypted before it is
persisted, and the passphrase is never stored.

| Function                                                       | Description                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `encryptToken(plaintext, passphrase): Promise<EncryptedToken>` | PBKDF2-SHA256, **600,000 iterations**, random 16-byte salt → AES-256-GCM with a random 96-bit IV |
| `decryptToken(encrypted, passphrase): Promise<string>`         | Reverses it; throws on a wrong passphrase or tampered data                                       |
| `storeToken(token, passphrase): Promise<void>`                 | Encrypts and writes the blob to `localStorage`                                                   |
| `retrieveToken(passphrase): Promise<string \| null>`           | Reads and decrypts; `null` when nothing is stored or the passphrase is wrong                     |
| `hasStoredToken(): boolean`                                    | Whether a blob exists (says nothing about decryptability)                                        |
| `clearStoredToken(): void`                                     | Removes the blob                                                                                 |

```ts
interface EncryptedToken {
    salt: string; // base64
    iv: string; // base64
    data: string; // base64 ciphertext
}
```

Also exported: `utf8ToBase64(text)` / `decodeBase64Utf8(base64)` for content
encoding, and `LIBRARY_VERSION`.

**Passphrase handling is your job.** The library deliberately does not persist
the passphrase — an app that generates a random one per session can never
decrypt the token again after a reload. The two workable patterns:

- Ask the user for a passphrase at connect time and keep it in `sessionStorage`
  (survives reloads in the same tab, gone when the tab closes). This is what the
  Vue todo demo does.
- Derive nothing, and ask for the passphrase on every launch.

Also note `encryptToken` costs ~0.3–1 s of PBKDF2 on a mid-range device — do it
once at connect time, not per request.

---

## Configuration helpers & constants

```ts
import {
    resolveConfig,
    assertValidCollectionName,
    assertValidRepoPath,
    COLLECTION_NAME_PATTERN,
    DEFAULT_BRANCH,
    DEFAULT_COMPACTION_THRESHOLD,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_BASE_DELAY,
    DEFAULT_DELETE_RETENTION_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_RAW_BASE_URL,
    DEFAULT_AUTO_SYNC_INTERVAL_MS,
    MAX_CONTENT_API_BYTES,
} from 'gittersync';
```

| Export                          | Value                                     |
| ------------------------------- | ----------------------------------------- |
| `DEFAULT_BRANCH`                | `'main'`                                  |
| `DEFAULT_COMPACTION_THRESHOLD`  | `20` changelog files                      |
| `DEFAULT_MAX_RETRIES`           | `3`                                       |
| `DEFAULT_RETRY_BASE_DELAY`      | `1_000` ms                                |
| `DEFAULT_DELETE_RETENTION_MS`   | `2_592_000_000` (30 days)                 |
| `DEFAULT_REQUEST_TIMEOUT_MS`    | `30_000` ms                               |
| `DEFAULT_RAW_BASE_URL`          | `'https://raw.githubusercontent.com'`     |
| `DEFAULT_AUTO_SYNC_INTERVAL_MS` | `300_000` (5 minutes)                     |
| `MAX_CONTENT_API_BYTES`         | `1_048_576` (GitHub's Contents API limit) |
| `COLLECTION_NAME_PATTERN`       | `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`     |

#### `resolveConfig(config): ResolvedGitHubSyncConfig`

Fills in every default and validates the result, throwing `ValidationError` for a
missing `owner`/`repo` or an invalid numeric option. Useful when you build config
UIs and want the same rules the service applies:

```ts
const resolved = resolveConfig({ owner: 'me', repo: 'data' });
resolved.branch; // 'main'
resolved.useRawContent; // true
resolved.deleteRetentionMs; // 2592000000
resolved.onSyncStatusChange; // no-op function, never undefined
```

`ResolvedGitHubSyncConfig` has the same fields as `GitHubSyncConfig` but none of
them optional.

#### `assertValidCollectionName(name): void`

Throws `ValidationError` unless the name matches `COLLECTION_NAME_PATTERN`.
Collection names become object-store names locally and repository paths remotely,
so this is the guard that keeps both safe.

#### `assertValidRepoPath(path): void`

Throws `ValidationError` for anything that could escape the repository or smuggle
an unexpected ref: empty/whitespace-only paths, leading `/`, `\`, `..` segments,
empty segments (`a//b`), control characters, and non-string input. Applied at
**every** read and write entry point (`fetchJsonFile`, `fetchTextFile`,
`writeFile`, `deleteFile`, `uploadFile`, `downloadFile`, …), including inside the
write-retry loop.

---

## Types reference

### Documents & collections

```ts
type DeviceId = string;

interface SyncCursor {
    sha: string;
    timestamp: string;
}

interface FieldMeta {
    updatedAt: string;
    device: DeviceId;
}

type FieldsMap = Record<string, FieldMeta>;

interface SyncedDocument<T = Record<string, unknown>> {
    id: string;
    data: T;
    _fields: FieldsMap;
    updated_at: string; // max of all field timestamps
    created_at: string;
    deleted_at: string | null;
    deleted_by: DeviceId | null;
}

interface CollectionFile<T = Record<string, unknown>> {
    collection: string;
    version: number;
    updatedAt: string;
    documents: Record<string, SyncedDocument<T>>;
}
```

### Changelog

```ts
type ChangelogOp = 'create' | 'update' | 'delete';

interface FieldChange {
    value: unknown;
    updatedAt: string;
}

interface ChangelogEntry {
    collection: string;
    docId: string;
    op: ChangelogOp;
    fields?: Record<string, FieldChange>; // update: only the changed fields
    deletedAt?: string; // delete
}

interface ChangelogFile {
    deviceId: DeviceId;
    timestamp: string;
    changes: ChangelogEntry[];
}
```

### Repository metadata

```ts
interface CollectionMeta {
    version: number;
    sha: string;
}

interface MetaFile {
    schemaVersion: number;
    collections: Record<string, CollectionMeta>;
    changelogCount: number;
}
```

### Migrations

```ts
type MigrationTransform = (
    collection: string,
    documents: Record<string, SyncedDocument>,
    meta: MetaFile,
) => Record<string, SyncedDocument>;

interface MigrationStep {
    from: number;
    to: number;
    description: string;
    transform: MigrationTransform;
}
```

### Files

```ts
type UploadableContent = string | Blob | ArrayBuffer | Uint8Array;

interface FileRef {
    path: string;
    sha: string;
    size: number;
    mimeType: string;
}

type ContentSource = 'api' | 'raw';

interface FetchFileOptions {
    forceApi?: boolean;
}

interface GitHubFileResult<T = unknown> {
    content: T;
    sha: string; // '' when served by raw and never read through the REST API
    source: ContentSource;
}
```

### Status & results

```ts
interface SyncStatus {
    isSyncing: boolean;
    isOnline: boolean;
    isInitialized: boolean;
    lastSyncAt: string | null;
    cursor: SyncCursor | null;
    deviceId: DeviceId; // '' before init()
    pendingChanges: number;
    repoSizeKb: number | null;
    rateLimitRemaining: number | null;
    rateLimitResetAt: string | null;
    rawContentActive: boolean;
}

interface RateLimitInfo {
    remaining: number | null;
    resetAt: string | null;
    apiCalls: number;
    rawReads: number;
    rawMisses: number;
    rawFallbacks: number;
    rawContentActive: boolean;
}

interface ApiUsage {
    apiCalls: number;
    rawReads: number;
    rawMisses: number;
    rawFallbacks: number;
}

type PullResult =
    | {
          type: 'full';
          collections: Record<string, CollectionFile>;
          meta: MetaFile | null;
          documentsMerged: number;
          changelogOps: number;
          apiCalls?: number;
          rawReads?: number;
      }
    | {
          type: 'incremental';
          collections: Record<string, CollectionFile>;
          changelogs: ChangelogFile[];
          documentsMerged: number;
          changelogOps: number;
          apiCalls?: number;
          rawReads?: number;
      }
    | { type: 'none' };

/** sync() = pull() + how much was pushed */
type SyncResult = PullResult & { pushed: number };

interface PushResult {
    pushed: number;
    changelogPath: string | null;
    compacted: boolean;
    apiCalls: number;
    rawReads: number;
}

interface CompactionResult {
    changelogsCompacted: number;
    collectionsWritten: string[];
    purgedDeletes: number;
    apiCalls: number;
}

interface ExportManifest {
    exportedAt: string;
    sourceVersion: string;
    collections: string[];
    changelogCount: number;
    fileCount: number;
}
```

---

## Errors

All four are exported classes extending `Error` with a stable `name`, so
`instanceof` works across module instances.

| Class             | Fields                               | Thrown when                                                                                                                       |
| ----------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `ConflictError`   | `path: string`, `attempt: number`    | GitHub answered 409 and `maxRetries` attempts are exhausted                                                                       |
| `RateLimitError`  | `resetAt: Date`, `remaining: number` | The hourly budget is exhausted (403 with `x-ratelimit-remaining: 0`, or the pre-write budget guard)                               |
| `AuthError`       | `status: number`                     | 401/403 from GitHub — bad, expired or insufficiently scoped token                                                                 |
| `ValidationError` | `path: string`, `reason: string`     | Invalid input: bad collection name, unsafe repository path, empty id, duplicate create, oversize upload, malformed import archive |

```ts
import { ConflictError, RateLimitError, AuthError, ValidationError } from 'gittersync';

try {
    await sync.push();
} catch (error) {
    if (error instanceof RateLimitError) {
        const minutes = Math.ceil((error.resetAt.getTime() - Date.now()) / 60_000);
        showMessage(
            `GitHub rate limit — try again in ~${minutes} min. Your changes are saved locally.`,
        );
    } else if (error instanceof ConflictError) {
        showMessage(`Write conflict on ${error.path}. Pulling remote changes…`);
        await sync.pull();
    } else if (error instanceof AuthError) {
        showMessage('Token rejected — reconnect your repository.');
    } else if (error instanceof ValidationError) {
        showMessage(`Invalid ${error.path}: ${error.reason}`);
    } else {
        throw error;
    }
}
```

Anything else (a network failure, an unexpected GitHub status) surfaces as a
plain `Error` with a descriptive message. Offline is not an error: mutations
stay queued and auto-sync resumes by itself.

---

## Recipes

### Offline-first UI wiring

```ts
const sync = new GitHubSyncService({ owner, repo, branch, onSyncStatusChange: render });
await sync.init(token);
await sync.registerCollections(['tasks']);

// Render from IndexedDB, never from the network
async function renderBoard() {
    const db = sync.getLocalDb();
    const docs = await db.getAllDocuments<Task>('tasks');
    draw(docs.map((doc) => ({ id: doc.id, ...doc.data })));
}

// Mutations are local; sync happens on its own schedule
async function moveTask(taskId: string, columnId: string) {
    await sync.getLocalDb().updateFields<Task>('tasks', taskId, { columnId });
    await renderBoard();
}

sync.startAutoSync(30_000);
await renderBoard();
```

### Attachments

```ts
const ref = await sync.uploadFile(`files/${taskId}/${file.name}`, file);
await db.updateFields<Task>('tasks', taskId, {
    attachments: [...(task.attachments ?? []), ref],
});

// Later, possibly offline for the metadata but online for the bytes:
const blob = await sync.downloadFile(ref.path);
```

Keep the `FileRef` in the document: it records `path`, `size` and `mimeType`, so
the UI can render an attachment list without any network call. Check
`file.size <= MAX_CONTENT_API_BYTES` before uploading to fail fast with your own
message — `uploadFile` validates too, but only after MIME inference.

### Moving a document between collections

There is no cross-collection update: delete from the source and upsert into the
target, so each collection's changelog tells its own story.

```ts
const doc = await db.getDocument<Task>(`column_${from}`, taskId);
if (doc) {
    const now = new Date().toISOString();
    const moved = {
        ...doc,
        data: { ...doc.data, columnId: to },
        _fields: { ...doc._fields, columnId: { updatedAt: now, device: db.getDeviceId() } },
        updated_at: now,
        deleted_at: null,
        deleted_by: null,
    };
    await db.deleteDocument(`column_${from}`, taskId);
    await db.putDocument(`column_${to}`, moved); // or createDocument() when new
}
```

### Schema migrations

```ts
const sync = new GitHubSyncService({
    owner,
    repo,
    branch,
    migrations: [
        {
            from: 1,
            to: 2,
            description: 'Split "name" into "firstName"/"lastName"',
            transform: (collection, documents) => {
                if (collection !== 'users') return documents;
                return Object.fromEntries(
                    Object.entries(documents).map(([id, doc]) => {
                        const [firstName = '', lastName = ''] = String(doc.data.name ?? '').split(
                            ' ',
                        );
                        const { name: _drop, ...rest } = doc.data as Record<string, unknown>;
                        return [id, { ...doc, data: { ...rest, firstName, lastName } }];
                    }),
                );
            },
        },
    ],
});
```

Migrations run during a pull when `meta.json.schemaVersion` is newer than the
local one, in `from` order, before anything is written locally. Bump the version
on the device that writes the new shape; everyone else follows on their next pull.

### Recovery checklist

| Symptom                     | Fix                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| "Collection not registered" | Call `registerCollections([...])` after `init()`                                     |
| Remote changes never appear | `await db.clearSyncCursor(); await sync.pull();`                                     |
| Writes keep conflicting     | `await sync.pull();` then push; raise `maxRetries` only if the repo has many writers |
| Rate limit exhausted        | Wait for `RateLimitError.resetAt`; verify `rawContentActive` is `true`               |
| Local state is nonsense     | `await sync.reset(); await sync.pull();`                                             |
| Test teardown hangs         | `await db.close()` before `indexedDB.deleteDatabase(...)`                            |

---

## Testing in Node

The library needs `indexedDB`, `fetch`, `Blob` and `crypto.subtle`. In Node 20+
the last three exist; IndexedDB comes from [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb):

```ts
import 'fake-indexeddb/auto';
import { LocalDB } from 'gittersync';

const db = new LocalDB();
await db.init();
```

Vitest tips learned the hard way:

- **Do not combine `vi.useFakeTimers()` with IndexedDB work.** `fake-indexeddb`
  schedules on `setImmediate`, which fake timers intercept, so any awaited
  operation hangs; and `vi.useRealTimers()` afterwards discards already-scheduled
  immediates, leaving a connection open that blocks every later
  `deleteDatabase`. Do your IDB setup before faking timers, or use real timers
  with `vi.waitFor(...)`.
- **Close before deleting**: `await db.close()` (or `await sync.destroy()`) then
  `indexedDB.deleteDatabase(name)`, and bound the delete with a `Promise.race`
  timeout so one stuck teardown cannot cascade.
- `fake-indexeddb` keeps databases for the whole process — wipe them in
  `afterEach` or state leaks between tests.
- Mocks of `GitHubApiAdapter` must honour the real contract: a 409 has to be a
  `ConflictError`, not a bare `{ status: 409 }` `Error`, or the retry loop will
  not see it. The service calls optional adapter methods defensively
  (`resetUsage?.()`), so a partial mock still works.
- `startAutoSync` clamps to 1,000 ms, so short-interval timer tests are not
  possible — assert the clamp instead.

---

## Versioning

```ts
import { LIBRARY_VERSION } from 'gittersync';
```

`LIBRARY_VERSION` always equals `package.json`'s version (a unit test asserts
it), and is written into `manifest.json` by `exportData()` so an import can tell
which version produced an archive.

GitterSync follows semver. Adding fields to result types, new methods and new
optional config keys are minor releases; renaming or removing a public method,
or changing the on-disk document/changelog shape, is a major one.

**Related documents**

- [README](../README.md) — overview, data format, quick start
- [GitHub setup](./github-setup.md) — creating the repository and the token
- [End-to-end verification](./e2e-verification.md) — manual test script
