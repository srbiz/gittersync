# Integration Tests

These tests exercise the **real GitHub API** — no mocks. They verify the full sync cycle end-to-end: init → registerCollections → pull → push → sync → conflict resolution → compaction → binary files → export/import → offline recovery.

| File | Scope |
|---|---|
| `sync.test.ts` | Full sync cycle: init, push, pull, status, compaction, concurrent devices |
| `e2e.test.ts` | Every user-facing flow, with genuinely isolated storage per simulated device (12 sections, see below) |

## Prerequisites

1. A GitHub Personal Access Token with `repo` scope
2. The token must be set in the `GITTERSYNC_TEST_TOKEN` environment variable

## Running

```bash
# Set the token (bash/zsh)
export GITTERSYNC_TEST_TOKEN="ghp_your_token_here"

# Run integration tests
npm run test:integration
```

### Two target modes

**Ephemeral repo mode (default)** — a temporary public repository named
`gittersync-test-*` is created for the run and deleted afterwards. Requires a
token that can create and delete repositories (classic PAT with `repo` +
`delete_repo`).

**Scratch branch mode** — set `GITTERSYNC_TEST_REPO=owner/repo` to run against
an existing repository. A uniquely named scratch branch
(`gittersync-e2e-<timestamp>-<rand>`) is created off the default branch, used as
the sync target and deleted afterwards. `main` is never written to, and the
harness refuses to delete anything that is not a `gittersync-e2e-*` branch.
Use this mode when the token cannot create repositories (GitHub App
installations, fine-grained tokens scoped to a single repo, CI sandboxes):

```bash
export GITTERSYNC_TEST_TOKEN="ghp_your_token_here"
export GITTERSYNC_TEST_REPO="your-user/your-scratch-repo"
npm run test:integration
```

The scratch branch must be a clean sync target (no `meta.json`, `collections/`,
`changelog/` or `files/` at its root) — the harness fails fast with a clear
message otherwise.

## What `e2e.test.ts` verifies

1. **Bootstrap & auth** — init, `registerCollections`, empty-branch full pull
2. **Push** — changelog file contents on GitHub, local queue drained
3. **Incremental pull** — Compare Commits path; `none` when nothing changed
4. **Multi-device convergence** — a second, storage-isolated device sees pushed data
5. **Different-field conflicts** — concurrent edits to different fields all survive
6. **Same-field conflicts** — last-write-wins, both devices converge on identical documents
7. **Delete propagation** — tombstones sync; soft-deleted docs hidden from default reads
8. **Compaction** — changelogs folded into collection files, changelog dir drained, `meta.json` updated, no data loss, fresh devices hydrate from collection files
9. **Binary files** — upload/download byte-exact round-trip, nested `files/<id>/<name>` layout, files-first ordering
10. **Export / import** — ZIP layout, manifest counts, import into a fresh device, corrupt ZIP rejected
11. **Offline behaviour** — changes queue while offline, auto-sync flushes on reconnect
12. **Status & history** — status surface accuracy, cursor matches remote head, commit history

## Notes

- jsdom has no IndexedDB: `setup-env.ts` (loaded via `setupFiles`) polyfills it
  with `fake-indexeddb`, and must run before Dexie is imported.
- Devices are isolated by swapping `Dexie.dependencies.indexedDB` for a fresh
  `IDBFactory` per device, so each simulated device gets its own database
  namespace and device ID.
- Integration tests are **not** part of `npm test` — they must be explicitly invoked.
- The CI workflow does **not** run integration tests (no token in CI).
- Auth-failure behaviour is covered by unit tests (`tests/github-api.test.ts`),
  not here: reads of a public repo succeed without valid credentials, and some
  sandboxes inject credentials at the network layer.

## Troubleshooting

- **Rate limiting**: GitHub API has rate limits. If you see 403 errors, wait a few minutes and retry.
- **Leftover repos**: If a test is interrupted, stale repos may remain. Re-running the tests will clean up repos older than 1 hour. You can also delete them manually from GitHub.
- **Leftover branches**: Interrupted runs can leave a `gittersync-e2e-*` branch. Delete it from the repository's branches page.
