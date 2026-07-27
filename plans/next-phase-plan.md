# GitterSync — Next Phase Plan

> Test coverage, CI/CD, linting, and npm publish preparation

---

## 1. Test Coverage

### Testing Challenges

The codebase relies on browser-only APIs that are not available in Node.js:

| Module | Browser Dependencies | Strategy |
|--------|---------------------|----------|
| `crypto.ts` | `crypto.subtle` (Web Crypto API), `localStorage`, `btoa`/`atob` | Switch Vitest to `jsdom` environment for this test file |
| `local-db.ts` | Dexie / IndexedDB, `crypto.randomUUID()` | Use `fake-indexeddb` polyfill + `jsdom` environment |
| `github-api.ts` | `Octokit`, `fetch`, `btoa` | Mock Octokit constructor and methods with `vi.mock()` |
| `sync-service.ts` | All of the above | Mock `GitHubApiAdapter`, `LocalDB`, and `merge` modules |

### Step 1.1 — Install test dependencies

```
npm install -D jsdom fake-indexeddb @types/fake-indexeddb
```

### Step 1.2 — Update `vitest.config.ts`

Add a `jsdom` environment override for test files that need browser APIs. Use per-file `@vitest/environment` comments instead of a global switch, so the existing merge tests stay fast in Node.

### Step 1.3 — `tests/crypto.test.ts`

Test cases:
- `encrypt()` + `decrypt()` round-trip — encrypt a string and decrypt it back
- `decrypt()` with wrong passphrase throws error
- `storeToken()` / `retrieveToken()` — encrypt-store-retrieve round-trip
- `hasStoredToken()` — returns false initially, true after store
- `clearStoredToken()` — removes stored token
- `encrypt()` produces different ciphertext for same input (random salt/IV)

### Step 1.4 — `tests/local-db.test.ts`

Test cases:
- `init()` generates a device ID on first call, returns same on second call
- `registerCollection()` creates a table, double-register is no-op
- `createDocument()` + `getDocument()` — round-trip
- `putDocument()` — creates or updates, queues changelog entry
- `deleteDocument()` — soft-deletes with `deleted_at`
- `getAllDocuments()` — filters soft-deletes by default, includes them when flag is set
- `replaceCollection()` — clears and replaces all docs
- `mergeDocuments()` — merges using provided merge function
- `getPendingChangelogEntries()` / `clearChangelogEntries()` — queue management
- `getSyncCursor()` / `setSyncCursor()` — cursor persistence
- `exportAll()` — exports all registered collections

### Step 1.5 — `tests/github-api.test.ts`

Mock `@octokit/rest` entirely using `vi.mock()`. Test cases:
- `init()` — success with valid token, throws `AuthError` on 401/403
- `init()` — throws on inaccessible repo
- `fetchJsonFile()` — decodes base64 JSON content, returns null on 404
- `createOrUpdateFile()` — creates new file when no SHA, updates when SHA exists
- `createOrUpdateFileWithRetry()` — retries on 409, throws after max retries
- `deleteFile()` — deletes by SHA, silent on 404
- `compareCommits()` — returns changed files, handles 404 gracefully
- `getLatestCommitSha()` — returns SHA
- `listDirectory()` — returns filenames, empty on 404
- `uploadBinaryFile()` — uploads base64 content
- `getRepoSize()` — returns size in KB
- `ensureInitialized()` — throws if not initialized
- Rate limit tracking from response headers

### Step 1.6 — `tests/sync-service.test.ts`

Mock `GitHubApiAdapter`, `LocalDB`, and `merge` module. Test cases:
- `init()` — initializes API and local DB
- `registerCollections()` — delegates to local DB
- `pull()` with no cursor — performs full pull
- `pull()` with cursor — performs incremental pull
- `pull()` when comparison is identical — returns `{ type: 'none' }`
- `push()` — pushes pending changelog entries, clears queue
- `push()` with no pending entries — no-op
- `push()` triggers compaction when changelog count exceeds threshold
- `sync()` — pull then push
- `sync()` retries on ConflictError
- `compact()` — merges changelogs into collections, deletes applied changelogs
- `uploadFile()` / `downloadFile()` — file operations
- `startAutoSync()` / `stopAutoSync()` — timer management
- `getStatus()` / `getFullStatus()` — status reporting
- `ensureInitialized()` — throws if not initialized

---

## 2. CI/CD with GitHub Actions

### Step 2.1 — Create `.github/workflows/ci.yml`

```mermaid
flowchart LR
    A[Push / PR] --> B[Install deps]
    B --> C[Type check - tsc --noEmit]
    C --> D[Lint - npm run lint]
    D --> E[Test - npm test]
    E --> F[Build - npm run build]
```

Triggers: `push` to `main`, `pull_request` to `main`

Jobs:
1. **check** — runs on `ubuntu-latest`, Node 20
   - `npm ci`
   - `npm run lint`
   - `npm test`
   - `npm run build`

### Step 2.2 — Create `.github/workflows/publish.yml`

Triggers: manual `workflow_dispatch` or push tag `v*`

Jobs:
1. **publish-npm** — runs on `ubuntu-latest`, Node 20
   - `npm ci`
   - `npm run build`
   - `npm publish --access public` (using `NPM_TOKEN` secret)

---

## 3. ESLint and Prettier

### Step 3.1 — Install dependencies

```
npm install -D eslint @eslint/js typescript-eslint prettier eslint-config-prettier
```

### Step 3.2 — Create `eslint.config.js`

Flat config using `typescript-eslint` with:
- Recommended rules
- Prettier integration via `eslint-config-prettier`
- Ignore patterns: `dist/`, `node_modules/`, `coverage/`

### Step 3.3 — Create `.prettierrc`

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 4
}
```

Match existing code style observed in the source files — the project uses 4-space indentation, single quotes, and semicolons.

### Step 3.4 — Update `package.json` scripts

```json
{
  "lint": "eslint src tests",
  "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'",
  "format:check": "prettier --check 'src/**/*.ts' 'tests/**/*.ts'"
}
```

Remove the old `"lint": "tsc --noEmit"` — type checking is covered by the build step and CI.

---

## 4. npm Publish Preparation

### Step 4.1 — Update `package.json`

- Add `"files"` field to whitelist: `["dist"]` — ensures only built output is published
- Add `"sideEffects": false` — enables tree-shaking
- Add `"repository"`, `"homepage"`, `"bugs"` fields
- Add `"prepublishOnly"` script: `"npm run build"` — safety net

### Step 4.2 — Create `.npmignore`

```
src/
tests/
plans/
.github/
.roo/
*.test.ts
vitest.config.ts
tsconfig.json
eslint.config.js
.prettierrc
```

### Step 4.3 — Verify package contents

Run `npm pack --dry-run` to confirm only `dist/` and `LICENSE` + `README.md` are included.

---

## Execution Order

1. Install test dependencies → update vitest config
2. Write `tests/crypto.test.ts`
3. Write `tests/local-db.test.ts`
4. Write `tests/github-api.test.ts`
5. Write `tests/sync-service.test.ts`
6. Verify all tests pass
7. Install ESLint + Prettier → create configs → update scripts
8. Run lint + format
9. Create GitHub Actions workflows
10. Update `package.json` for npm publish → create `.npmignore`
11. Final verification: build, test, lint all pass
