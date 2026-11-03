# GitterSync — Vue 3 Todo Demo

A deliberately small todo app that shows the shortest useful path through
GitterSync: **Vue 3 (`<script setup>`) + Vite + Pinia**, one collection, no
backend. The GitHub repository _is_ the database.

Live: <https://srbiz.github.io/gittersync/todo/> (the vanilla-TypeScript kanban
demo lives one level up at <https://srbiz.github.io/gittersync/>).

| Concern                                        | Where                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| App state, CRUD, sync actions                  | [`src/stores/todos.ts`](src/stores/todos.ts) — one Pinia setup store |
| Connecting, encrypted token, service lifecycle | [`src/lib/gittersync.ts`](src/lib/gittersync.ts)                     |
| Data shape                                     | [`src/types.ts`](src/types.ts)                                       |
| UI                                             | [`src/components/*.vue`](src/components)                             |
| Tests                                          | [`tests/`](tests) — 34 tests, store + components                     |

---

## What it demonstrates

- **Offline-first writes.** Add, toggle, rename and delete go straight to
  IndexedDB through `LocalDB`; the network is never on the critical path. Try it
  with DevTools offline — everything still works, and the pending count in the
  status bar shows what will be pushed later.
- **Field-level updates.** Toggling a todo calls `updateFields('todos', id, { done })`,
  which stamps only that field. Two devices editing _different_ fields of the
  same todo merge without a conflict.
- **Soft deletes.** Deleting queues a `delete` changelog entry instead of erasing
  the row, so other devices converge rather than resurrecting the todo.
- **Local-only mode.** "Try it offline (no GitHub)" runs `LocalDB` on its own —
  no token, no repository, no network. It is the same store and the same
  components; only the sync buttons change.
- **Raw reads.** `useRawContent: true` (the library default) serves collection and
  changelog reads from `raw.githubusercontent.com`, which does not count against
  the 5,000/hour REST budget. The status bar shows `N free reads · M API calls`
  so the difference is visible.
- **Encrypted token storage.** The PAT is encrypted with a passphrase
  (PBKDF2-SHA256, 600k iterations → AES-256-GCM) before it reaches
  `localStorage`. The passphrase is kept in `sessionStorage` only, so a reload in
  the same tab can reconnect, and closing the tab makes the stored blob
  undecryptable.
- **Error UX.** `RateLimitError`, `ConflictError`, `AuthError` and
  `ValidationError` are turned into sentences a user can act on
  (`describeError()` in the store, covered by tests).

---

## Running it

The demo imports the library **from source**, so build the package once first:

```bash
# from the repository root
npm ci
npm run build          # produces dist/, which the demo's "gittersync" alias resolves

cd demo-vue
npm ci
npm run dev            # http://localhost:5173/gittersync/todo/
```

Other scripts:

```bash
npm run build      # vue-tsc --noEmit && vite build  → dist/
npm run typecheck  # vue-tsc --noEmit
npm test           # vitest run (jsdom + fake-indexeddb)
npm run preview    # serve the production build
```

`vite.config.ts` sets `base: '/gittersync/todo/'` and aliases
`gittersync → ..`, so the demo always exercises the library in this repository
rather than a published copy.

---

## Connecting a repository

1. Create an **empty** repository (a private one is fine).
2. Create a personal access token: classic with the `repo` scope, or
   fine-grained with **Contents: read and write** on that repository.
3. Open the demo, paste the token, type a passphrase (or hit **Generate**), set
   owner/repo/branch and press **Connect**.

The first sync creates `collections/todos.json`, `changelog/` and `meta.json` in
the repository. See [`docs/github-setup.md`](../docs/github-setup.md) for the
longer walkthrough.

> The default owner/repo in the form (`srbiz/gittersync-demo-data`) is the
> maintainer's scratch repository. Use your own — two people writing to the same
> repository is exactly what the merge logic is for, but it is not a shared demo
> account.

---

## Data layout

In the repository:

```
collections/todos.json     # every todo, with per-field timestamps
changelog/<device>-<n>.json # deltas waiting to be folded in
meta.json                  # schema version + collection SHAs
```

A todo document:

```jsonc
{
    "id": "0f0d…",
    "data": {
        "id": "0f0d…",
        "title": "Write the docs",
        "done": false,
        "createdAt": "2026-11-04T09:00:00.000Z",
        "updatedAt": "2026-11-04T09:12:00.000Z",
        "completedAt": null,
    },
    "_fields": {
        "title": { "updatedAt": "2026-11-04T09:12:00.000Z", "device": "dev-a1b2c3" },
        "done": { "updatedAt": "2026-11-04T09:00:00.000Z", "device": "dev-a1b2c3" },
    },
    "updated_at": "2026-11-04T09:12:00.000Z",
    "created_at": "2026-11-04T09:00:00.000Z",
    "deleted_at": null,
    "deleted_by": null,
}
```

Locally, the same documents live in the IndexedDB database
`gittersync_collections` (store `col_todos`), with the pending-write queue in the
`gittersync` database.

---

## How the store is put together

`src/stores/todos.ts` is a Pinia **setup store**, which keeps the reactive parts
obvious:

```ts
export const useTodoStore = defineStore('todos', () => {
    const todos = ref<Todo[]>([]); // UI state
    const service = shallowRef<GitHubSyncService | null>(null); // class instance — shallow!
    const status = shallowRef<SyncStatus | null>(null); // replaced wholesale

    const visibleTodos = computed(/* filtered + sorted */);

    async function addTodo(title: string) {
        /* LocalDB.create */
    }
    async function syncNow() {
        /* service.sync() */
    }

    return { todos, service, status, visibleTodos, addTodo, syncNow /* … */ };
});
```

Three details that matter if you copy this into your own app:

- **`shallowRef` for the service and the status object.** A `GitHubSyncService`
  holds Dexie connections, timers and an Octokit instance; making it deeply
  reactive is slow and can break the library's internals. `status` is replaced
  wholesale by `onSyncStatusChange`, so shallow reactivity is enough.
- **`autoSync` is store state, not `service.autoSyncRunning`.** The interval flag
  lives on the (shallow) service instance, so Vue cannot see it change.
- **Every mutation is followed by a UI update from the returned document**, not by
  a re-read. `refreshFromLocal()` exists for the cases where the database is the
  only source of truth (after a pull, after a reconnect).

---

## Tests

```bash
npm test
```

| File                       | Covers                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tests/todo-store.test.ts` | Local-only mode, CRUD, persistence round-trips, changelog queueing, filters/getters, notices, `describeError`, id generation |
| `tests/components.test.ts` | `TodoInput`, `TodoItem` and `TodoFilters` mounted with `@vue/test-utils` against a real store                                |

They run in `jsdom` with `fake-indexeddb`, so the whole offline path is exercised
for real — no GitHub, no mocks of the library. Two rules the tests follow (and
that you will need if you add more):

- Store actions write through IndexedDB, which settles _after_ the DOM update, so
  component assertions use `vi.waitFor(...)`.
- `fake-indexeddb` keeps databases for the whole process: `teardownStore()`
  disconnects the store and deletes both databases in `afterEach`.

---

## Deployment

`.github/workflows/deploy-demo.yml` builds this app and the kanban demo, then
merges them into one GitHub Pages artifact:

```
demo/dist/            →  https://<user>.github.io/gittersync/
demo/dist/todo/       →  https://<user>.github.io/gittersync/todo/
```

That is why `base` is `/gittersync/todo/` here and `/gittersync/` in the kanban
demo, and why the kanban top bar links to `todo/` with a relative URL.

---

## Ideas if you want to extend it

- Drag-to-reorder with a `position` field (update it via `updateFields` so only
  that field is stamped).
- Due dates + a `queryDocuments` filter for "today".
- Attachments: `sync.uploadFile(\`files/${todo.id}/${name}\`, file)`and store the
returned`FileRef` on the todo.
- A conflict viewer using `sync.getRateLimitInfo()` and `PullResult.documentsMerged`.
- Export/import buttons wired to `sync.exportData()` / `sync.importData()`.

Full API details: [`docs/api.md`](../docs/api.md).
