# GitterSync

**GitHub as a free database backend** — offline-first sync with per-collection files, incremental changelogs, and field-level conflict resolution.

[![Live Demo](https://img.shields.io/badge/demo-live-00d4aa?style=for-the-badge)](https://srbiz.github.io/gittersync/)
[![npm version](https://img.shields.io/npm/v/gittersync?color=00d4aa&label=npm)](https://www.npmjs.com/package/gittersync)
[![CI](https://img.shields.io/github/actions/workflow/status/srbiz/gittersync/ci.yml?branch=main)](https://github.com/srbiz/gittersync/actions)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 🎮 Live Demo

Try GitterSync in action with our [**Kanban Board Demo**](https://srbiz.github.io/gittersync/) — a fully functional project management app that showcases every feature of the library:

- ✅ **Task CRUD** with offline-first sync
- ✅ **Drag & drop** between columns (field-level conflict resolution)
- ✅ **File attachments** with files-first ordering
- ✅ **Auto-sync** with configurable interval
- ✅ **Online/offline detection** with auto-retry on reconnect
- ✅ **Real-time status dashboard** (sync cursor, pending changes, rate limit)
- ✅ **Token encryption** with AES-256-GCM passphrase protection

> **Quick start:** Open the demo, enter a GitHub PAT with `repo` scope, and start creating tasks. The default demo repo is ready to use!

### 🔑 GitHub Token Guidance

To use the demo or the library, you need a GitHub Personal Access Token (PAT). You can use either:

1.  **Classic Token (Recommended for Demo):**
    *   Go to [Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens).
    *   Generate a new token with the **`repo`** scope.
    *   This is the simplest way to get started.

2.  **Fine-grained Token:**
    *   Go to [Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
    *   Select the repository you want to use as a database.
    *   Grant **Read and write** access to **"Contents"** and **"Metadata"**.
    *   This is more secure but requires manual repo selection.

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
import { GitHubSyncService, storeToken, retrieveToken } from 'gittersync'

// 1. Create a sync service
const sync = new GitHubSyncService({
  owner: 'your-username',
  repo: 'your-data-repo',
  branch: 'main',
  compactionThreshold: 20,   // compact after 20 changelog entries
  deleteRetentionMs: 30 * 24 * 60 * 60 * 1000,  // purge soft-deletes after 30 days
})

// 2. Initialize with a GitHub Personal Access Token
const token = 'ghp_xxxxxxxxxxxx'
await sync.init(token)

// 3. Register your collections
await sync.registerCollections(['users', 'posts'])

// 4. Pull remote data into local IndexedDB
const result = await sync.pull()
console.log(result.type) // 'full' | 'incremental' | 'none'

// 5. Work with local data via the LocalDB API
// (Access the localDb instance from the service)

// 6. Push local changes to GitHub
await sync.push()

// 7. Full sync (pull + push with conflict retry)
await sync.sync()
```

## Token Security

GitterSync provides AES-256-GCM encryption for storing GitHub tokens in `localStorage`:

```typescript
import { storeToken, retrieveToken, hasStoredToken, clearStoredToken } from 'gittersync'

// Encrypt and store the token with a user-provided passphrase
await storeToken('ghp_xxxxxxxxxxxx', 'user-passphrase')

// Retrieve and decrypt
const token = await retrieveToken('user-passphrase')

// Check if a token is stored
if (hasStoredToken()) { /* ... */ }

// Remove the stored token
clearStoredToken()
```

> **Note:** For production apps, GitHub OAuth is recommended over PAT storage. The encryption utility is a fallback for scenarios where OAuth isn't feasible.

## Auto-Sync

```typescript
// Start periodic sync every 5 minutes (default)
sync.startAutoSync()

// Custom interval
sync.startAutoSync(2 * 60 * 1000) // every 2 minutes

// Stop auto-sync
sync.stopAutoSync()
```

### Online/Offline Detection

GitterSync automatically detects browser connectivity and handles offline scenarios:

- **Skip sync when offline** — `startAutoSync()` checks `navigator.onLine` before each sync cycle and skips if the browser is offline, avoiding wasted network errors
- **Auto-retry on reconnect** — when the browser fires the `online` event, GitterSync immediately triggers a sync so changes are pushed as soon as connectivity returns
- **Visibility** — the `isOnline` property and `SyncStatus.isOnline` field let your UI reflect the current connectivity state

```typescript
// Check connectivity state
console.log(sync.isOnline) // true | false

// In non-browser environments (Node.js), isOnline defaults to true
```

> **Note:** Online/offline detection uses the browser's `navigator.onLine` property and `online`/`offline` events. In non-browser environments (Node.js, SSR), `isOnline` defaults to `true` since there's no standard connectivity API.

## Binary File Sync

```typescript
// Upload a file (creates files/{filename} in the repo)
const fileRef = await sync.uploadFile('avatar.png', blob)

// Download a file
const blob = await sync.downloadFile('files/avatar.png')
```

## Compaction

Changelog entries accumulate over time. Compaction merges them into the main collection files and purges expired soft-deletes:

```typescript
await sync.compact()
```

Compaction is also automatically triggered during `push()` when pending changelog entries exceed the configured `compactionThreshold`.

## Conflict Resolution

GitterSync uses **field-level Last-Write-Wins (LWW)**:

1. When two devices edit different fields of the same document, both changes are preserved
2. When two devices edit the same field, the one with the later timestamp wins
3. On equal timestamps, the remote version takes priority
4. Soft-deletes use a separate `deleted_at` field — a newer edit overrides an older delete

## Sync Status

```typescript
const status = sync.getStatus()
// {
//   isSyncing: boolean
//   isOnline: boolean        // current connectivity state
//   isInitialized: boolean
//   lastSyncAt: string | null
//   pendingChanges: number
//   deviceId: string
//   cursor: SyncCursor | null
//   repoSizeKb: number | null
//   rateLimitRemaining: number | null
// }

const fullStatus = await sync.getFullStatus()
// Same as getStatus(), plus repo size and rate limit info
// fetched asynchronously from GitHub
```

## API Reference

### `GitHubSyncService`

| Method | Description |
|--------|-------------|
| `init(token)` | Initialize with GitHub token |
| `registerCollections(names)` | Register collection names |
| `pull()` | Pull remote changes (full or incremental) |
| `push()` | Push local changelog entries to GitHub |
| `sync()` | Pull then push with conflict retry |
| `compact()` | Merge changelogs into collections, purge expired deletes |
| `uploadFile(name, blob)` | Upload a binary file |
| `downloadFile(path)` | Download a binary file |
| `startAutoSync(intervalMs?)` | Start periodic sync (skips when offline, auto-retries on reconnect) |
| `stopAutoSync()` | Stop periodic sync and remove online/offline listeners |
| `getStatus()` | Get sync status (includes `isOnline`) |
| `getFullStatus()` | Get detailed sync status with repo/rate-limit info |
| `isOnline` | Read-only property — current connectivity state |

### Merge Algorithms

| Function | Description |
|----------|-------------|
| `mergeDocument(local, remote)` | Field-level LWW merge of two documents |
| `mergeCollection(local, remote)` | Merge two collection files |
| `applyChangelogToCollection(collection, entries)` | Apply changelog entries to a collection |
| `createDocument(data, deviceId)` | Create a new SyncedDocument with field metadata |
| `createChangelogEntry(op, docId, fields, deviceId)` | Create a changelog entry |
| `getExpiredDeletes(collection, maxAgeMs)` | Find IDs of expired soft-deletes |

### Error Classes

| Class | Description |
|-------|-------------|
| `ConflictError` | GitHub 409 conflict (concurrent pushes) |
| `RateLimitError` | GitHub API rate limit exceeded |
| `AuthError` | Authentication failure (401/403) |
| `ValidationError` | Invalid input parameters |

## Repository Structure

When using GitterSync, your GitHub repo will look like:

```
repo/
├── meta.json                          # Global metadata (collections, schema version)
├── collections/
│   ├── users.json                     # Per-collection document store
│   └── posts.json
├── changelogs/
│   └── 2026-07-27T10-00-00_deviceA.json   # Incremental change entries
└── files/
    └── avatar.png                     # Binary file attachments
```

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run lint

# Run unit tests (135 tests, excludes integration)
npm test

# Run integration tests (requires GITTERSYNC_TEST_TOKEN)
npm run test:integration

# Build
npm run build

# Watch tests
npm run test:watch

# Check formatting
npm run format:check
```

### Demo Application

A full-featured [Kanban Board demo](https://srbiz.github.io/gittersync/) is included in the `demo/` directory:

```bash
# Install demo dependencies
cd demo && npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

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

See [`tests/integration/README.md`](tests/integration/README.md) for details.

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