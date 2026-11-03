# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0]

The "spend fewer GitHub requests, document everything, and make the demos
trustworthy" release.

### Added

**Raw content transport — reads no longer cost rate limit**

- New `src/raw-content.ts` with an exported `RawContentClient` that reads
  committed file content from `raw.githubusercontent.com`, which is **not** part
  of the REST rate limit (5,000/hour authenticated, 60/hour anonymous).
- New config options: `useRawContent` (**default `true`**), `rawBaseUrl`,
  `rawCacheBust`, `requestTimeoutMs`.
- Every read path uses it: `fetchJsonFile`, `fetchTextFile`, `downloadBinaryFile`
  — and therefore `pull()`, `downloadFile()` and attachment reads.
- Definite fallback rules: raw is only trusted when the response is a real `200`
  or a real `404`, the payload parses, and — for private repositories — the token
  can be used. An anonymous 404 on a private repo is treated as "unavailable"
  (fall back to REST), never as "file does not exist", which would silently lose
  data.
- New `FetchFileOptions.forceApi` to bypass raw for a single read. Compaction and
  the `meta.json` read use it, because they are write-critical: a CDN-cached copy
  could resurrect data another device just compacted.
- Telemetry: `ApiUsage` / `getRateLimitInfo()` report `apiCalls`, `rawReads`,
  `rawMisses`, `rawFallbacks` and `rawContentActive`, so an app can show how many
  reads were free.

**Configuration module**

- New `src/config.ts`: `resolveConfig()`, `assertValidCollectionName()`,
  `assertValidRepoPath()`, `COLLECTION_NAME_PATTERN`, `ResolvedGitHubSyncConfig`
  and the defaults (`DEFAULT_BRANCH`, `DEFAULT_COMPACTION_THRESHOLD`,
  `DEFAULT_MAX_RETRIES`, `DEFAULT_RETRY_BASE_DELAY`, `DEFAULT_DELETE_RETENTION_MS`,
  `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_RAW_BASE_URL`,
  `DEFAULT_AUTO_SYNC_INTERVAL_MS`, `MAX_CONTENT_API_BYTES`).
- Repository paths are validated at **every** read and write entry point
  (including inside the write-retry loop): no leading `/`, no `\`, no `.`/`..`/empty
  segments, no control characters.
- New `deleteRetentionMs` option (default 30 days): how long soft-deleted
  documents survive before compaction purges them.

**Sync results you can report on**

- `PullResult` variants now carry `documentsMerged` and `changelogOps`.
- New `SyncResult` type: `sync()` returns the pull outcome **plus** `pushed`, so a
  UI can summarise a whole cycle from one call.

**`LocalDB`**

- Dynamic schema discovery: `registerCollection()` reads the native IndexedDB
  schema (`indexedDB.open(name)` without a version), re-declares every existing
  `col_*` store and bumps to `max(verno, ceil(idbVersion / 10)) + 1`, closing the
  previous connection first. Registering a new collection in a second session no
  longer throws `SchemaError`/`VersionError`.
- `init()` is idempotent — concurrent calls share one promise.
- New reads: `getAllDocumentsMap()`, `queryDocuments(predicate)`,
  `getDocumentCount()`.
- New writes: `restoreDocument()`, `replaceCollection()`, `mergeDocuments()`,
  `clearCollection()`; `putDocument()`/`createDocument()` take a
  `queueChangelog` flag so remote state is never echoed back.
- Changelog queue API: `queueChangelogEntry()`, `getPendingChangelogEntries()`
  (FIFO by `queuedAt`, ties by `localId`), `getPendingChangelogCount()`,
  `clearChangelogEntries(ids)`, `clearAllChangelogEntries()`.
- Cursor/meta API: `getSyncCursor()` (self-heals corrupt JSON), `setSyncCursor()`,
  `clearSyncCursor()`, `getSchemaVersion()`, `setSchemaVersion()`,
  `getMetaValue()`, `setMetaValue()`.
- Bulk/teardown: `exportAll()`, `clearAll()`, `close()`, `getMetaDatabase()`,
  `getCollectionsDatabase()`, plus the exported `META_DB_NAME` /
  `COLLECTIONS_DB_NAME` constants and the `LocalChangelogEntry` / `SyncMeta` types.

**`GitHubSyncService`**

- `getRateLimitInfo()`, `getPendingChanges()`, `getConfig()`, `getApi()`,
  `destroy()`, `reset()`, `autoSyncRunning`, `autoSyncInterval`.
- `deleteFile()` and `listFiles()` (Git Trees API — 1 REST call at any depth).
- `uploadFile()` accepts `Blob`/`File`, base64, `data:` URLs, `ArrayBuffer` and
  `Uint8Array`; infers the MIME type from the extension; defaults the commit
  message to `Upload <name>`; validates the path; and rejects payloads over
  GitHub's 1 MiB Contents API limit **before** any network call (with base64
  padding accounted for).
- `getStatus()` is synchronous and returns real cached values instead of
  placeholders.

**`GitHubApiAdapter`**

- Blob SHA cache, so the common write is a single `PUT` instead of `GET` + `PUT`.
- `writeFile()` returns `WriteResult` (`path`, `blobSha`, `commitSha`,
  `parentShas`) — the metadata the cursor-safety rule needs.
- `compareCommits()` returns `headSha`, `aheadBy`, `behindBy`.
- `getUsage()` / `resetUsage()`, `rawContentActive`, `getCachedRepoSize()`,
  `repoIsPrivate`, `getLastCommit()`, `clearShaCache()`.
- Pre-write rate-limit budget guard: throws `RateLimitError(resetAt, remaining)`
  when the budget is exhausted instead of spending a doomed request.

**Documentation**

- **`docs/api.md`** — a complete reference for every public export: the
  `GitHubSyncService` config table, the full `LocalDB` API (including the
  write-tier table and per-method semantics), `GitHubApiAdapter`, the raw content
  transport and its fallback rules, merge algorithms, token encryption, config
  helpers and constants, every type, every error class, a per-operation
  rate-limit budget, recipes (offline-first wiring, attachments, moving documents
  between collections, migrations, a recovery checklist) and Node testing notes.
- README: new "Rate Limits & Raw Content" section, a `LocalDB` section, corrected
  signatures throughout, the real repository layout (`changelog/`, not
  `changelogs/`) and a working Quick Start that uses `getLocalDb()`.

**New demo — Vue 3 + Pinia todo app (`demo-vue/`)**

- Vue 3 `<script setup>`, Vite, Pinia setup store, four components, dark theme.
- Offline-first CRUD, filters, rename-in-place, clear-completed, auto-sync,
  compaction, pull/push, and a status bar showing pending changes, cursor, last
  sync and "N free reads · M API calls".
- **"Try it offline (no GitHub)"** runs `LocalDB` standalone — no token, no
  repository — which is also how its tests run.
- Encrypted token storage with the passphrase kept in `sessionStorage` (survives a
  reload, dies with the tab) instead of being regenerated per session.
- `describeError()` maps `RateLimitError`, `ConflictError`, `AuthError` and
  `ValidationError` to sentences a user can act on.
- 34 tests (jsdom + `fake-indexeddb` + `@vue/test-utils`) covering the store and
  the components; deployed at `/gittersync/todo/`.

**Tests & CI**

- Root suite: **173 → 324 tests**. New files: `raw-content` (23),
  `github-api-raw` (24), `config` (16), `local-db-schema` (25),
  `sync-service-improvements` (42), `demo-task-detail` (19 — the kanban dialog,
  including the regression tests for the label bug below).
- CI gains a `demos` job that builds both demos (`tsc`/`vue-tsc` + Vite) and runs
  the Vue demo's tests, so a breaking library change fails the build instead of
  shipping.
- The Pages workflow builds both demos and merges them into one artifact
  (`/gittersync/` and `/gittersync/todo/`), and now also triggers on `src/**`.

**Packaging**

- `exports` map (`.` → `dist/index.js` with `types`), `engines.node >= 20`,
  `test:demos` / `build:demos` scripts.

### Changed

- **Reads go through `raw.githubusercontent.com` by default.** Consequence: a
  `GitHubFileResult.sha` can be `''` for a file this instance has only read from
  raw — raw responses carry no blob SHA. Pass `{ forceApi: true }` when you need
  an authoritative SHA. Set `useRawContent: false` to restore the old
  REST-only behaviour.
- `sync()` returns `SyncResult` (`PullResult & { pushed: number }`) instead of
  `PullResult`.
- `deleteDocument()` returns `boolean` (`false` when the document was absent or
  already deleted).
- `replaceCollection()` no longer queues changelog entries — it is how a full pull
  installs remote state, and echoing it back would re-push other devices' data.
- `startAutoSync()` clamps the interval to a 1,000 ms floor and pauses cycles
  until `RateLimitError.resetAt`, warning **once** per pause (message contains
  `paused until`) instead of on every tick.
- Compaction reads collection files with `{ forceApi: true }`.
- `meta.json`'s `changelogCount` after a compaction is the number of changelog
  files actually left in the repository, not a hardcoded `0`.
- API call counting is explicit at each REST call site rather than derived from an
  Octokit `hook.after` (which never fires under mocks); the service calls optional
  adapter methods defensively, so partial mocks work.

### Fixed

**Kanban demo — the Edit Task dialog**

- **Labels could not be dismissed.** Chips rendered from the saved task had no
  click handler at all (only chips added during the session did), and labels typed
  into the dialog survived a close/reopen cycle. A new state-driven
  `label-editor` component owns the label list, so every chip is removable and
  closing the dialog discards unsaved labels.
- Label colours were read back from `span.style.color`, i.e. as `rgb(59, 130, 246)`,
  producing invalid CSS like `background: rgb(59,130,246)20`. Colours are now
  normalised to `#rrggbb` on the way in (`normalizeColor()` also repairs legacy
  `rgb()` data) and on the way out.
- The dialog resolved nine elements with `document.getElementById` — with two
  dialogs open it wired up the wrong one, and a second dialog could be stacked on
  top of the first. Everything is scoped to the overlay now, and only one dialog
  can be open at a time.
- Escape and backdrop clicks did not close the dialog, and `close()` only removed
  the overlay (keydown listeners and the label editor leaked). Both are handled.
- **Attachments on a new task were lost**: uploads ran in parallel with (or before)
  `createTask()`, so the metadata update targeted a document that did not exist
  yet. Submission is now files-first and sequential — `createTask()` →
  `uploadAttachment()` per file → `updateTask()` only for existing tasks — with a
  1 MiB pre-check, a hint in the UI, and a busy/double-submit guard.
- Card labels escape their text and normalise legacy colours.

**Kanban demo — the rest**

- `subscribe()` leaked a listener on every board render and every status-panel
  open, so detached DOM kept being written and panel buttons were bound twice.
  Both now keep their unsubscribe handle.
- `state.lastSyncAt` was never populated; it now comes from `SyncStatus`.
- The auto-sync checkbox was wired through a `MutationObserver` watching for an
  element that already existed in the markup just written.
- `moveTaskToColumn()` only stamped `columnId`, losing the move against a
  concurrent edit, and used `table.add()` on the target collection — a repeated
  drop threw on the duplicate key. It now stamps `columnId` + `position` and
  upserts.
- `uploadAttachment()` passes the `File` straight to `uploadFile()` instead of
  hand-rolling base64, and uses the `FileRef`'s size/MIME.
- The status panel shows the raw/API read split.

**Library**

- A push could advance the sync cursor past commits written by other devices,
  making their changes invisible until the next full pull. The cursor now moves
  only when the new commit's `parentShas` contain it, and a device that has never
  pulled does not get a cursor from a push at all.
- `compareCommits()` could return `merge_base_commit.sha` as `headSha` (moving the
  cursor **backwards**), and silently accepted GitHub's truncation at 250 commits /
  300 files. Truncated or unknown-base compares are now reported as `diverged`,
  which clears the cursor and degrades to a full pull instead of skipping data.
- A diverged or unresolvable cursor used to apply "no changed files"; it now falls
  back to a full pull.
- `sync()` retried a `ConflictError` by recursing — unbounded. It is now a bounded
  `maxRetries` loop.
- `getStatus()` returned placeholder values for `lastSyncAt`, `deviceId`,
  `pendingChanges`, `repoSizeKb` and `rateLimitRemaining`.
- There was no way to stop a service: timers and `online`/`offline` listeners
  leaked and the IndexedDB connection stayed open. `destroy()` closes everything.
- `uploadFile()` mis-reported sizes for base64/`data:` payloads (padding counted as
  content), accepted only strings, and did not validate paths; `exportData()` did
  not recurse into `files/` subdirectories.
- Soft-deletes were purged with no retention window, which could resurrect a
  deleted document on a device that had not synced in a while.
- Rate-limit exhaustion produced a warning per attempt; it now surfaces one
  `RateLimitError` and one warning per pause.
- Overlapping `push()`/`pull()`/`sync()` calls could interleave; operations are
  serialised, and a `sync()` that arrives during another operation reports
  `{ type: 'none', pushed: 0 }` instead of queueing behind it.
- A corrupt sync cursor threw on read; it is now cleared and reported as `null`,
  costing a full pull instead of a broken app.

### Known issue

- `compact()` is not atomic: if a device crashes mid-compaction, applied
  changelogs may be re-applied on the next pull. The merge is idempotent
  (timestamp-based LWW), so this converges, but a partially compacted repository
  can hold duplicate information until the next compaction.

## [1.4.1] and earlier

See the git history and [`docs/e2e-verification.md`](docs/e2e-verification.md) for
the end-to-end verification run that preceded 1.5.0.

[1.5.0]: https://github.com/srbiz/gittersync/compare/v1.4.1...v1.5.0
