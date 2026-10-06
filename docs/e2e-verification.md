# End-to-End Flow Verification

Date: 2026-10-06 · Library version: 1.4.0

All user-facing flows were exercised against the **real GitHub API** (no mocks),
using the new `tests/integration/e2e.test.ts` suite and two isolated simulated
devices per run. Every reported result below is reproducible with:

```bash
export GITTERSYNC_TEST_TOKEN="ghp_..."
export GITTERSYNC_TEST_REPO="owner/scratch-repo"   # optional; avoids creating repos
npm run test:integration
```

## Result summary

| Suite | Result |
|---|---|
| Unit tests (`npm test`) | 173 passed (158 before + 15 new regression tests) |
| Unit tests under Node 20 | 173 passed (previously 12 failures — see defect 7) |
| Integration (`e2e.test.ts`) | 21 passed |
| Integration (`sync.test.ts`) | 10 passed |
| `npm run lint` / `format:check` / `typecheck` / `build` | clean |
| Demo build (`demo/npm run build`) | clean |

## Flows verified

1. **Bootstrap** — `init()`, `registerCollections()`, full pull on an empty branch returns `none`.
2. **Push** — changelog file contents on GitHub match local documents; local queue drained.
3. **Incremental pull** — Compare Commits path downloads only changed files; `none` when the branch is unchanged (no redundant downloads).
4. **Multi-device convergence** — a second device with its own IndexedDB namespace and device ID receives pushed data.
5. **Field-level conflicts (different fields)** — concurrent edits to `role` and `email` on two devices both survive; devices converge on identical documents.
6. **Same-field conflicts (LWW)** — the newest write wins on both devices; unrelated fields are preserved.
7. **Deletes** — soft-deletes propagate as tombstones; deleted documents disappear from default reads but remain in `includeDeleted` reads and exports.
8. **Compaction** — triggered automatically at the threshold: changelogs folded into `collections/*.json`, changelog directory drained, `meta.json` rewritten with per-collection SHAs, no data loss, and a brand-new device hydrates entirely from collection files.
9. **Binary files** — upload/download byte-exact round-trip; nested `files/<taskId>/<name>` layout (what the demo app uses); files-first ordering, so metadata never references a missing blob.
10. **Export** — ZIP contains the documented `gittersync-export/` tree (`manifest.json`, `meta.json`, `collections/`, `changelog/`, nested `files/`), and the manifest counts match reality.
11. **Import** — a fresh device restores collection data, clears its cursor, re-validates against remote and can fetch imported attachments.
12. **Offline** — writes queue while offline (auto-sync skips its cycles), then flush automatically when the `online` event fires; the remote advances.
13. **Status** — `getFullStatus()` reports device ID, pending count, repo size, rate limit and a cursor equal to the remote head SHA.
14. **Corrupt input** — a non-ZIP upload is rejected with `ValidationError`, leaving local data untouched.

## Defects found and fixed

### 1. New devices saw nothing when data lived only in changelogs (data loss)

`fullPull()` derived collection names from `meta.json` or by listing
`collections/`. Nothing has been compacted on a young repo, so both were empty
and the method returned `{ type: 'none' }` **before reading the changelog
directory** — and before establishing a sync cursor. A second device (or a
reinstall) therefore never received any data, and stayed broken because no
cursor was saved.

*Fix:* when no collection files exist, collection names are derived from the
changelog entries; `none` is only returned when both the collections directory
and the changelog directory are empty.

### 2. `op: 'update'` entries for unseen documents were dropped (data loss)

`LocalDB.putDocument()` always queues `op: 'update'` (unlike `createDocument()`),
and both changelog appliers skipped update entries whose document was not
present locally:

```ts
if (!existing) continue; // Can't update a non-existent document
```

Consequences: a device pulling a changelog for a document it had not seen silently
lost that document, and — worse — **compaction discarded data permanently**: the
entry was skipped while being folded into `collections/*.json`, and the changelog
file was deleted afterwards. The existing integration test masked this because
its second device shared the first device's IndexedDB.

*Fix:* update entries now upsert (create the document when it is unknown), in both
`applyChangelogToCollection()` and the local apply path. Delete entries for unknown
documents now write a tombstone so a deletion cannot be lost or resurrected.

### 3. Compaction could roll back newer fields (data loss)

Changelog entries carry **every** field of a document (`putDocument` echoes all
fields, not just the changed one), and `applyChangelogToCollection()` applied them
unconditionally — no timestamp comparison, unlike the local apply path. A stale
echo could therefore overwrite a newer value in a collection file during
compaction and re-attribute its provenance.

*Fix:* the compaction path now applies the same field-level LWW rule as the local
path (`incoming > current`), so stale echoes are ignored and unchanged fields keep
their original provenance.

### 4. Exports silently dropped nested attachments

`exportData()` listed `files/` with the non-recursive `listDirectory()`, which
returns only direct children. The demo app stores attachments as
`files/<taskId>/<fileName>`, so every demo export contained **no attachments**
and reported `fileCount: 0`.

*Fix:* added `GitHubApiAdapter.listDirectoryRecursive()` (Git Trees API) and used
it for the export; nested paths are preserved in the ZIP.

### 5. Exported ZIP did not match the documented structure

`exportData()` called `folder.generateAsync()`; JSZip strips the folder name when
generating from a folder object, so the ZIP had `manifest.json` at the root
instead of the documented `gittersync-export/manifest.json`. The manifest also
hard-coded `sourceVersion: '1.3.1'`.

*Fix:* generate from the ZIP root to keep the documented structure, and report
`LIBRARY_VERSION` (new `src/version.ts`, asserted against `package.json` by a test).

### 6. The integration suite could not run as documented

Two independent problems, both invisible because CI never runs integration tests:

- `vitest.config.integration.ts` used jsdom, which has no IndexedDB, so every test
  in `sync.test.ts` failed with `MissingAPIError: IndexedDB API missing`. Fixed by
  adding `tests/integration/setup-env.ts` (polyfills `fake-indexeddb`) via
  `setupFiles`.
- `sync.test.ts` asserted a pull result of `'none'` / `'fast-forward'` — an older
  API. `pull()` returns a `PullResult` object today. Assertions updated to the
  current API, and the concurrency test now also verifies the second device's write
  reached the remote.

### 7. Token encryption failed on Node 20 (pre-existing CI failure)

`npm test` passed locally on Node 22 but failed on Node 20 with 12 errors in
`tests/crypto.test.ts`:

```
TypeError: Failed to normalize algorithm: 'salt' of 'Pbkdf2Params'
(passed algorithm) is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.
```

The suite runs in a jsdom environment, so typed arrays it creates belong to the
jsdom realm. `src/crypto.ts` passed raw `.buffer` values to WebCrypto; Node 20's
implementation rejects a foreign-realm `ArrayBuffer` for `Pbkdf2Params.salt`,
while accepting typed-array *views* (the spec-valid `BufferSource`). This had been
failing on `main` since 2026-07-28 — CI runs two Node versions and only one is
shown as red at a glance.

*Fix:* pass typed-array views (`salt`, `iv`, `data`) instead of `.buffer`, and type
`base64ToUint8Array()` as `Uint8Array<ArrayBuffer>` so the value satisfies TS's
`BufferSource`. A regression test now exercises the cross-realm path.

### 8. Time-dependent unit test

`getExpiredDeletes` fixtures used fixed July 2026 dates: once the wall clock passed
2026-07-27 the "recent" delete counted as expired and `npm test` failed. Fixtures
are now anchored to `Date.now()`.

## Observations (not changed)

- **`init()` does not validate the token.** `init()` checks repository access; on a
  public repository an invalid token still returns `true`, and the first write is
  what fails. That is a deliberate trade-off for public read-only repos — but apps
  should expect write failures rather than an early `AuthError`.
- **`meta.json` `schemaVersion` starts at 0** until an app sets one via
  `LocalDB.setSchemaVersion()` and compacts; the README's `"schemaVersion": 1`
  example is only a format illustration. Documented in the E2E test instead of
  changing migration semantics.
- **Manual `sync()` still hits the network while offline.** Only the auto-sync loop
  checks the online flag, so `sync()` called directly while offline throws instead
  of queueing. Queueing already happens at write time via the changelog table, so no
  data is lost — but the behaviour is worth documenting.
- **Local storage names are fixed** (`gittersync`, `gittersync_collections`), so
  multi-device tests must isolate storage explicitly (as `e2e.test.ts` does by
  swapping `Dexie.dependencies.indexedDB`).
- **Sandbox caveat:** in this verification environment the network layer injects
  GitHub credentials, so a bogus-token write could not be used to assert 401/403.
  Auth-failure mapping stays covered by unit tests.
