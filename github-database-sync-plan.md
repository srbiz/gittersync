# GitHub as a Free Database Backend — Complete Plan

> Use GitHub as a free, serverless database backend for offline-first apps.
> Store data locally (IndexedDB/Dexie.js) and sync via GitHub's Content API.
> No Supabase, no Firebase, no monthly bills — just a free GitHub account.

---

## Table of Contents

1. [The Core Idea](#1-the-core-idea)
2. [Architecture Overview](#2-architecture-overview)
3. [Repository Structure](#3-repository-structure)
4. [GitHub API Setup](#4-github-api-setup)
5. [Data Format](#5-data-format)
6. [Sync Algorithm](#6-sync-algorithm)
7. [Conflict Resolution](#7-conflict-resolution)
8. [File Storage for Documents](#8-file-storage-for-documents)
9. [Security Considerations](#9-security-considerations)
10. [Pros vs Cons](#10-pros-vs-cons)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Code Sketch: GitHubSyncService](#12-code-sketch-githubsyncservice)
13. [What This Replaces](#13-what-this-replaces)
14. [Edge Cases & Failure Modes](#14-edge-cases--failure-modes)
15. [Alternative Approaches](#15-alternative-approaches)

---

## 1. The Core Idea

**Problem**: Cloud databases (Supabase, Firebase, MongoDB Atlas) charge monthly fees. For personal projects or small teams, these costs add up quickly.

**Solution**: Use **GitHub** as a free database backend:
- Store your entire database as a **single JSON file** (or split into multiple files) in a **private GitHub repository**
- Use the **GitHub Content API** to pull/push data
- Every sync creates a **Git commit** — giving you free version history
- **No server to maintain**, **no monthly bills**, **no vendor lock-in**

**The Flow**:
```
┌─────────────────────┐         ┌──────────────────────────────┐
│   Your App (PWA)    │         │   GitHub Repository (Free)   │
│                     │         │                              │
│  ┌───────────────┐  │  GET    │  ┌────────────────────────┐  │
│  │  Dexie.js     │  │◄────────│  │  db.json               │  │
│  │  (Local DB)   │  │  PUT    │  │  (Full data snapshot)  │  │
│  └───────┬───────┘  │────────►│  └────────────────────────┘  │
│          │          │         │                              │
│  ┌───────┴───────┐  │         │  ┌────────────────────────┐  │
│  │  GitHub Sync  │  │         │  │  changelog/            │  │
│  │  Service      │  │         │  │  ├─ change_001.json    │  │
│  └───────────────┘  │         │  │  ├─ change_002.json    │  │
│                     │         │  │  └─ ...                │  │
└─────────────────────┘         │  └────────────────────────┘  │
                                └──────────────────────────────┘
```

---

## 2. Architecture Overview

### Components

| Component | Role |
|---|---|
| **Local Database** (Dexie.js / IndexedDB) | Primary data store. All reads/writes happen here. Zero-latency, fully offline. |
| **GitHubSyncService** | Sync engine. Pulls from GitHub on startup, pushes local changes periodically. |
| **GitHub Repository** (private) | Remote backup & sync medium. Stores `db.json` + files. |
| **GitHub Content API** | REST API for reading/writing files in the repo. |
| **Personal Access Token (PAT)** | Authentication for API calls. |

### Data Flow

```
App Start
    │
    ▼
Load from Dexie (local) ────► Display UI immediately (offline-first)
    │
    ▼
Check last sync timestamp
    │
    ├── If GitHub has newer data ──► Download → Merge → Update Dexie
    │
    └── If local has unsynced changes ──► Push to GitHub
                │
                ▼
        GitHub creates a commit
        (free version history!)
```

---

## 3. Repository Structure

Create a **private** GitHub repository (e.g., `my-app-db`) with this structure:

```
my-app-db/
│
├── db.json                    # Main database (all collections in one file)
│
├── files/                     # Uploaded documents/files
│   ├── doc_abc123.pdf
│   ├── doc_def456.jpg
│   └── ...
│
├── changelog/                 # Optional: incremental change logs
│   ├── 2026-07-27T12-00-00Z.json
│   └── 2026-07-27T13-00-00Z.json
│
└── meta.json                  # Sync metadata (version, last sync timestamp)
```

### Alternative: Split by Collection

For larger datasets, split into separate files:

```
my-app-db/
├── collections/
│   ├── users.json
│   ├── documents.json
│   ├── cases.json
│   ├── activities.json
│   └── messages.json
├── files/
│   └── ...
└── meta.json
```

---

## 4. GitHub API Setup

### Authentication

**Option A: Personal Access Token (PAT) — Simplest**
1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a token with:
   - **Repository access**: Only select repos (choose your db repo)
   - **Permissions**: Contents (Read and write)
3. Store the token in the app (localStorage or encrypted storage)
4. Rate limit: **5,000 requests/hour** for authenticated requests

**Option B: GitHub OAuth App — For multi-user**
1. Register an OAuth App on GitHub
2. Implement OAuth flow in your app
3. Each user authorizes and gets their own token
4. More complex but more secure for multi-user scenarios

### API Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /repos/{owner}/{repo}/contents/{path}` | GET | Read a file from the repo |
| `PUT /repos/{owner}/{repo}/contents/{path}` | PUT | Create or update a file |
| `DELETE /repos/{owner}/{repo}/contents/{path}` | DELETE | Delete a file |
| `GET /repos/{owner}/{repo}/commits` | GET | List commits (change history) |
| `GET /repos/{owner}/{repo}/git/blobs/{sha}` | GET | Download a file blob |
| `POST /repos/{owner}/{repo}/git/blobs` | POST | Upload a file blob |

### Rate Limiting

- **Authenticated**: 5,000 requests/hour
- **Unauthenticated**: 60 requests/hour
- For a personal app, 5,000/hr is plenty (~1.4 requests/second sustained)
- Strategy: Batch changes, cache aggressively, sync only when needed

---

## 5. Data Format

### db.json Structure

```json
{
  "meta": {
    "version": "2.1",
    "lastSynced": "2026-07-27T12:00:00Z",
    "schemaVersion": 1
  },
  "collections": {
    "users": [
      {
        "id": "u1",
        "name": "John Doe",
        "email": "john@example.com",
        "updated_at": "2026-07-27T10:00:00Z",
        "created_at": "2026-07-01T08:00:00Z"
      }
    ],
    "documents": [
      {
        "id": "d1",
        "title": "Bank Notice.pdf",
        "type": "pdf",
        "fileRef": "files/doc_abc123.pdf",
        "tags": ["bank", "notice"],
        "updated_at": "2026-07-27T11:00:00Z",
        "created_at": "2026-07-20T09:00:00Z"
      }
    ],
    "cases": [
      {
        "id": "c1",
        "title": "Bank Freeze Case #123",
        "status": "active",
        "updated_at": "2026-07-26T15:00:00Z",
        "created_at": "2026-07-15T10:00:00Z"
      }
    ]
  }
}
```

### Per-Document Metadata

Each document must have:
- `id` — Unique identifier (UUID or custom)
- `updated_at` — ISO 8601 timestamp (used for conflict resolution)
- `created_at` — ISO 8601 timestamp

Optional:
- `deleted` — Soft delete flag (for sync propagation)
- `version` — Monotonic version number (for conflict detection)

---

## 6. Sync Algorithm

### Full Sync Flow

```
1. App starts
   │
2. Load data from Dexie (local) → Display UI immediately
   │
3. Check lastSync timestamp (from localStorage or meta table)
   │
4. GET db.json from GitHub (via Content API)
   │
   ├── SUCCESS:
   │   │
   │   ├── Compare remote.lastSynced vs local.lastSynced
   │   │
   │   ├── If remote is newer:
   │   │   │   For each collection:
   │   │   │       For each document:
   │   │   │           If remote doc.updated_at > local doc.updated_at
   │   │   │               → Update local (Dexie) with remote version
   │   │   │           If local doc.updated_at > remote doc.updated_at
   │   │   │               → Keep local version (will push later)
   │   │   │
   │   │   └── Update lastSynced timestamp
   │   │
   │   └── If local has unsynced changes:
   │       │   Merge local changes into remote data
   │       │   PUT updated db.json to GitHub
   │       │   → GitHub creates a commit automatically
   │       └── Update lastSynced timestamp
   │
   └── FAIL (network error):
       └── Queue changes for later sync (offline queue)
```

### Push Flow (Triggered by data changes)

```
1. User creates/updates/deletes data locally
   │
2. Update Dexie immediately (offline-first)
   │
3. Mark change as "unsynced" in a queue
   │
4. Debounce (wait 2 seconds for more changes)
   │
5. If online:
   │   Read current db.json from GitHub
   │   Merge local changes
   │   PUT updated db.json
   │   Clear "unsynced" queue
   │
   └── If offline:
       └── Keep in queue, retry when online
```

### Pull Flow (Triggered periodically)

```
1. Every 5 minutes (or on app resume)
   │
2. GET db.json from GitHub
   │
3. Compare timestamps
   │
4. If remote has newer data:
   │   Merge into Dexie
   │   Notify UI of changes
   │
   └── If not:
       └── Do nothing
```

---

## 7. Conflict Resolution

### Strategy: Last-Write-Wins (LWW) Per Document

This is the simplest and most practical strategy for single-user or small-team apps.

**Rules**:
1. Each document has an `updated_at` timestamp
2. When merging, the document with the **newer** `updated_at` wins
3. If timestamps are equal, the **remote** version wins (server authority)

**Merge Algorithm**:

```javascript
function mergeCollections(localCollections, remoteCollections) {
  const merged = {}

  // Get all collection names from both sides
  const allCollections = new Set([
    ...Object.keys(localCollections),
    ...Object.keys(remoteCollections)
  ])

  for (const collectionName of allCollections) {
    const localDocs = localCollections[collectionName] || []
    const remoteDocs = remoteCollections[collectionName] || []

    // Index remote docs by ID
    const remoteMap = new Map(remoteDocs.map(d => [d.id, d]))

    // Merge: start with all remote docs, overwrite with newer local docs
    const mergedDocs = [...remoteDocs]

    for (const localDoc of localDocs) {
      const remoteDoc = remoteMap.get(localDoc.id)
      if (!remoteDoc) {
        // New local document → add it
        mergedDocs.push(localDoc)
      } else if (new Date(localDoc.updated_at) > new Date(remoteDoc.updated_at)) {
        // Local is newer → replace remote
        const idx = mergedDocs.findIndex(d => d.id === localDoc.id)
        mergedDocs[idx] = localDoc
      }
      // If remote is newer → keep remote (already in mergedDocs)
    }

    merged[collectionName] = mergedDocs
  }

  return merged
}
```

### Handling Deletes

Use **soft deletes** to propagate deletions across devices:

```json
{
  "id": "d1",
  "title": "Bank Notice.pdf",
  "deleted": true,
  "updated_at": "2026-07-27T12:00:00Z"
}
```

During sync:
- If a document has `deleted: true` and is newer than local → delete from local
- Periodically purge soft-deleted documents (e.g., after 30 days)

### Advanced: Version Vectors

For multi-user scenarios, use version vectors instead of timestamps:

```json
{
  "id": "d1",
  "version": { "user1": 5, "user2": 3 },
  "data": { ... }
}
```

- Each user increments their own counter
- Conflicts detected when both users have edited
- Can be resolved automatically (LWW) or manually (UI prompt)

---

## 8. File Storage for Documents

### Approach 1: Direct File Upload (Small files, <1MB)

Use GitHub's Content API to upload files directly:

```javascript
async function uploadFile(file, fileName) {
  const reader = new FileReader()
  const content = await new Promise((resolve) => {
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.readAsDataURL(file)
  })

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: `files/${fileName}`,
    message: `Upload file ${fileName}`,
    content: content, // base64 encoded
  })
}
```

**Limitations**:
- Max file size: **100MB** per file (GitHub limit)
- Base64 encoding adds ~33% overhead
- Each file creates a separate commit

### Approach 2: Git Blobs API (Larger files)

Use the Git Data API for more control:

```javascript
async function uploadFileAsBlob(file) {
  // 1. Create a blob
  const blob = await octokit.git.createBlob({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    content: file, // base64
    encoding: 'base64',
  })

  // 2. Store blob SHA in db.json
  return blob.data.sha
}
```

### Approach 3: Git LFS (Very large files)

For files >100MB, use Git LFS:
- Free tier: **1GB storage**, **1GB bandwidth/month**
- Paid: $5/month for 50GB

### File Reference in Database

```json
{
  "id": "doc_abc123",
  "title": "Bank Notice.pdf",
  "fileRef": "files/doc_abc123.pdf",
  "fileSha": "a1b2c3d4e5f6...",  // Git blob SHA
  "fileSize": 245760,
  "mimeType": "application/pdf",
  "updated_at": "2026-07-27T12:00:00Z"
}
```

---

## 9. Security Considerations

| Concern | Risk Level | Solution |
|---|---|---|
| PAT exposed in client | **High** | Use fine-grained PAT with minimal permissions (only one repo, only contents read/write) |
| Token theft | **High** | Implement GitHub OAuth flow instead of hardcoded PAT; token rotation |
| Data visibility | **Medium** | Use a **private** repository |
| Man-in-the-middle | **Medium** | All GitHub API calls are HTTPS-only |
| Data tampering | **Medium** | Optional: sign data with a secret key before pushing |
| Multi-user access | **Medium** | Each user gets their own PAT or OAuth token |
| Rate limit exhaustion | **Low** | Cache aggressively, batch updates, stay under 5,000/hr |

### Recommended Security Setup

1. **Create a dedicated GitHub account** for the app (or use a bot account)
2. **Create a fine-grained PAT** with:
   - Only the database repository
   - Only `Contents: Read and write` permission
3. **Store the PAT** in the app's localStorage (or use the Web Crypto API to encrypt it)
4. **For production**: Implement GitHub OAuth so each user authenticates with their own GitHub account

### Encrypting Sensitive Data

For legal/financial data, encrypt the `db.json` before pushing:

```javascript
import { encrypt, decrypt } from './crypto'

async function pushWithEncryption(data, encryptionKey) {
  const encrypted = await encrypt(JSON.stringify(data), encryptionKey)
  const base64 = btoa(encrypted)

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: 'db.json.enc',
    message: `Sync ${new Date().toISOString()}`,
    content: base64,
    sha: currentSha,
  })
}
```

---

## 10. Pros vs Cons

### ✅ Pros

| Benefit | Details |
|---|---|
| **100% Free** | No Supabase, no Firebase, no server costs |
| **Version History** | Every sync is a Git commit — full audit trail for free |
| **No Vendor Lock-in** | Your data is a plain JSON file — portable anywhere |
| **Simple** | No complex backend setup, no DevOps |
| **Reliable** | GitHub's infrastructure — 99.9%+ uptime |
| **Transparent** | You can view/edit data directly on GitHub.com |
| **Branching** | Use Git branches for testing/experimental data |
| **Collaboration** | Multiple people can access the same repo |
| **No Maintenance** | Zero server maintenance, zero database administration |

### ❌ Cons

| Limitation | Impact | Mitigation |
|---|---|---|
| **Rate Limited** | 5,000 API calls/hour | Cache aggressively, batch updates |
| **No Real-time Sync** | Must poll or manually trigger | Auto-sync every 5 minutes |
| **No Auth System** | No built-in user management | GitHub OAuth or PAT per user |
| **File Size Limit** | 100MB per file | Split large datasets, use Git LFS |
| **Single File Bottleneck** | Whole DB is one JSON file | Split by collection for large datasets |
| **No Server-side Queries** | Must download entire DB to query | IndexedDB handles local queries |
| **Conflict Risk** | LWW can lose concurrent edits | Version vectors for multi-user |
| **No Push Notifications** | Can't notify other devices | Polling or webhooks |
| **No Search** | No full-text search on server | Local search via Dexie |
| **No Backups** | GitHub is the backup | Keep local Dexie as primary |

### When to Use This Approach

**Good for**:
- ✅ Personal projects (single user)
- ✅ Small teams (2-5 users)
- ✅ Offline-first apps
- ✅ Prototypes and MVPs
- ✅ Apps with moderate data volume (<100MB)
- ✅ Legal/financial tools where you want data control

**Not ideal for**:
- ❌ Large-scale multi-user apps
- ❌ Real-time collaborative apps
- ❌ Apps requiring server-side queries
- ❌ Apps with >100MB of data
- ❌ Apps requiring push notifications

---

## 11. Implementation Roadmap

### Phase 1: Basic Sync (Week 1)

- [ ] Create a private GitHub repo for the database
- [ ] Generate a GitHub PAT with `repo` scope
- [ ] Build `GitHubSyncService` class:
  - `fetchDb()` — Download `db.json` from GitHub
  - `pushDb(data)` — Upload `db.json` to GitHub
  - `getLastSync()` — Read sync timestamp
- [ ] Add a "Sync Now" button in the app
- [ ] On startup, pull from GitHub and merge into Dexie
- [ ] Handle basic errors (network failure, auth failure)

### Phase 2: Automatic Sync (Week 2)

- [ ] Auto-sync on app startup
- [ ] Auto-sync after significant changes (debounced, 2s delay)
- [ ] Background sync every 5 minutes
- [ ] Visual sync status indicator (syncing, synced, error, offline)
- [ ] Handle offline gracefully (queue changes, retry when online)
- [ ] Show last synced timestamp in UI

### Phase 3: Advanced Features (Week 3)

- [ ] Split large collections into separate files
- [ ] Implement incremental sync (only push changed documents)
- [ ] Add file/document storage via Git blobs
- [ ] Conflict resolution UI (manual merge for conflicts)
- [ ] Encryption at rest (encrypt `db.json` before pushing)
- [ ] Data compression (gzip before push to reduce size)

### Phase 4: Multi-Device & Collaboration (Week 4)

- [ ] GitHub OAuth flow for user authentication
- [ ] Per-user data isolation (separate files or paths)
- [ ] Shared data between users (team collaboration)
- [ ] Webhook-based notifications (GitHub webhooks → serverless function)
- [ ] Data export/import (download full backup as ZIP)
- [ ] Admin dashboard (view sync status, force sync, resolve conflicts)

---

## 12. Code Sketch: GitHubSyncService

### Installation

```bash
npm install @octokit/rest
```

### Full Service Implementation

```javascript
// githubSyncService.js
import { Octokit } from '@octokit/rest'
import logger from './logger'

const GITHUB_OWNER = 'your-username'
const GITHUB_REPO = 'my-app-db'
const DB_FILE_PATH = 'db.json'

class GitHubSyncService {
  constructor() {
    this.octokit = null
    this.lastSync = null
    this.isSyncing = false
    this.unsyncedChanges = 0
    this.onSyncStatusChange = null // Callback for UI updates
  }

  /**
   * Initialize the service with a GitHub PAT
   */
  async init(token) {
    this.octokit = new Octokit({ auth: token })

    // Verify the token works
    try {
      const { data } = await this.octokit.repos.get({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
      })
      logger.info('GitHub sync initialized', { repo: data.full_name })
      return true
    } catch (error) {
      logger.error('GitHub sync init failed', error)
      throw new Error('Failed to initialize GitHub sync. Check your token and repo name.')
    }
  }

  /**
   * Pull the latest db.json from GitHub
   */
  async pull() {
    this._setSyncing(true)

    try {
      const { data } = await this.octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: DB_FILE_PATH,
      })

      // Decode base64 content
      const content = JSON.parse(atob(data.content))

      this.lastSync = {
        sha: data.sha,
        timestamp: content.meta?.lastSynced || new Date().toISOString(),
      }

      logger.info('GitHub pull successful', {
        collections: Object.keys(content.collections || {}).length,
        sha: data.sha.slice(0, 7),
      })

      return content
    } catch (error) {
      if (error.status === 404) {
        // db.json doesn't exist yet — first time setup
        logger.info('No db.json found on GitHub, starting fresh')
        return null
      }
      logger.error('GitHub pull failed', error)
      throw error
    } finally {
      this._setSyncing(false)
    }
  }

  /**
   * Push data to GitHub as db.json
   */
  async push(data) {
    this._setSyncing(true)

    try {
      // Get current file SHA (required for update)
      let currentSha = null
      try {
        const { data: current } = await this.octokit.repos.getContent({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          path: DB_FILE_PATH,
        })
        currentSha = current.sha
      } catch (error) {
        if (error.status !== 404) throw error
        // File doesn't exist yet — will create new
      }

      // Encode to base64
      const jsonString = JSON.stringify(data, null, 2)
      const content = btoa(unescape(encodeURIComponent(jsonString)))

      const { data: result } = await this.octokit.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: DB_FILE_PATH,
        message: `Sync ${data.meta?.lastSynced || new Date().toISOString()}`,
        content,
        sha: currentSha,
      })

      this.lastSync = {
        sha: result.content.sha,
        timestamp: data.meta?.lastSynced || new Date().toISOString(),
      }

      this.unsyncedChanges = 0
      logger.info('GitHub push successful', { sha: result.content.sha.slice(0, 7) })

      return result
    } catch (error) {
      logger.error('GitHub push failed', error)
      throw error
    } finally {
      this._setSyncing(false)
    }
  }

  /**
   * Full sync: pull remote, merge with local, push result
   */
  async sync(localData) {
    if (this.isSyncing) {
      logger.warn('Sync already in progress, skipping')
      return null
    }

    try {
      // Step 1: Pull remote data
      const remoteData = await this.pull()

      if (!remoteData) {
        // No remote data — push local as initial
        const data = {
          meta: {
            version: '1.0',
            lastSynced: new Date().toISOString(),
            schemaVersion: 1,
          },
          collections: localData,
        }
        await this.push(data)
        return data
      }

      // Step 2: Merge local and remote
      const merged = this._merge(localData, remoteData.collections)

      // Step 3: Push merged data
      const data = {
        meta: {
          ...remoteData.meta,
          lastSynced: new Date().toISOString(),
        },
        collections: merged,
      }

      await this.push(data)
      return data
    } catch (error) {
      logger.error('Full sync failed', error)
      throw error
    }
  }

  /**
   * Merge local and remote collections (Last-Write-Wins per document)
   */
  _merge(localCollections, remoteCollections) {
    const merged = {}

    // Get all collection names
    const allCollections = new Set([
      ...Object.keys(localCollections || {}),
      ...Object.keys(remoteCollections || {}),
    ])

    for (const collectionName of allCollections) {
      const localDocs = localCollections[collectionName] || []
      const remoteDocs = remoteCollections[collectionName] || []

      // Index remote docs by ID
      const remoteMap = new Map(remoteDocs.map(d => [d.id, d]))

      // Start with all remote docs
      const mergedDocs = [...remoteDocs]

      for (const localDoc of localDocs) {
        const remoteDoc = remoteMap.get(localDoc.id)

        if (!remoteDoc) {
          // New local document
          mergedDocs.push(localDoc)
        } else if (new Date(localDoc.updated_at) > new Date(remoteDoc.updated_at)) {
          // Local is newer — replace
          const idx = mergedDocs.findIndex(d => d.id === localDoc.id)
          mergedDocs[idx] = localDoc
        }
        // If remote is newer — keep remote (already in mergedDocs)
      }

      merged[collectionName] = mergedDocs
    }

    return merged
  }

  /**
   * Upload a file to the GitHub repo
   */
  async uploadFile(file, fileName) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const base64Content = reader.result.split(',')[1]

          const { data } = await this.octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: `files/${fileName}`,
            message: `Upload file ${fileName}`,
            content: base64Content,
          })

          logger.info('File uploaded', { fileName, sha: data.content.sha.slice(0, 7) })
          resolve({
            sha: data.content.sha,
            path: `files/${fileName}`,
          })
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
  }

  /**
   * Download a file from the GitHub repo
   */
  async downloadFile(filePath) {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: filePath,
      })

      // Decode base64 to binary
      const binary = atob(data.content)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }

      return new Blob([bytes], { type: 'application/octet-stream' })
    } catch (error) {
      logger.error('File download failed', { filePath, error })
      throw error
    }
  }

  /**
   * Get sync status
   */
  getStatus() {
    return {
      isSyncing: this.isSyncing,
      lastSync: this.lastSync,
      unsyncedChanges: this.unsyncedChanges,
    }
  }

  /**
   * Mark that local data has changed (call after any local mutation)
   */
  markChanged() {
    this.unsyncedChanges++
  }

  _setSyncing(value) {
    this.isSyncing = value
    if (this.onSyncStatusChange) {
      this.onSyncStatusChange(this.getStatus())
    }
  }
}

export const githubSyncService = new GitHubSyncService()
```

### Usage in an App

```javascript
// app.js
import { githubSyncService } from './githubSyncService'
import { db } from './database'

// Initialize on app start
const TOKEN = localStorage.getItem('github_token')
await githubSyncService.init(TOKEN)

// Listen for sync status changes
githubSyncService.onSyncStatusChange = (status) => {
  updateSyncIndicator(status)
}

// Pull on startup
const remoteData = await githubSyncService.pull()
if (remoteData) {
  await mergeIntoDexie(remoteData.collections)
}

// After local data changes
async function onDataChanged() {
  githubSyncService.markChanged()

  // Debounce: wait 2 seconds for more changes
  clearTimeout(window._syncTimeout)
  window._syncTimeout = setTimeout(async () => {
    const localData = await exportFromDexie()
    await githubSyncService.sync(localData)
  }, 2000)
}

// Manual sync button
document.getElementById('syncButton').addEventListener('click', async () => {
  const localData = await exportFromDexie()
  await githubSyncService.sync(localData)
  showToast('Sync complete!')
})
```

---

## 13. What This Replaces

If you're currently using a cloud database service, here's what the GitHub approach replaces:

| Service | Replaced By |
|---|---|
| **Supabase Database** | `db.json` in GitHub repo |
| **Supabase Auth** | GitHub PAT or OAuth |
| **Supabase Realtime** | Manual polling (every 5 min) |
| **Supabase Storage** | GitHub files/blobs |
| **Firebase Firestore** | `db.json` in GitHub repo |
| **Firebase Auth** | GitHub OAuth |
| **Firebase Storage** | GitHub files/blobs |
| **MongoDB Atlas** | `db.json` in GitHub repo |
| **Custom Backend Server** | GitHub Content API |
| **Serverless Functions** | GitHub Actions (optional) |

### What You Keep

| Component | Keep? | Reason |
|---|---|---|
| **Local Database (Dexie/IndexedDB)** | ✅ Keep | Primary data store for offline-first |
| **Offline Queue** | ✅ Keep | Queue changes when offline |
| **UI Components** | ✅ Keep | Unchanged |
| **State Management (Pinia/Vuex)** | ✅ Keep | Unchanged |
| **Service Layer** | 🔄 Modify | Replace API calls with GitHub sync |

---

## 14. Edge Cases & Failure Modes

### 1. First-Time Setup (No db.json on GitHub)

**Scenario**: App runs for the first time, no `db.json` exists in the repo.

**Handling**:
- `pull()` returns `null` (404 handled gracefully)
- First `push()` creates the file
- No merge needed — just upload local data

### 2. Concurrent Writes (Two devices push simultaneously)

**Scenario**: Device A and Device B both push within seconds. The second push will fail because the SHA has changed.

**Handling**:
- GitHub returns `409 Conflict` if SHA doesn't match
- Catch the error, re-pull, re-merge, re-push
- Retry up to 3 times

```javascript
async function pushWithRetry(data, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await push(data)
    } catch (error) {
      if (error.status === 409 && attempt < maxRetries) {
        // SHA conflict — re-pull and merge
        const remote = await pull()
        data = merge(data, remote)
        continue
      }
      throw error
    }
  }
}
```

### 3. Offline Changes While Another Device Synced

**Scenario**: User edits on Phone (offline). User edits on Laptop (online, synced to GitHub). Phone comes online.

**Handling**:
- Phone pulls from GitHub
- Merge algorithm detects conflicts
- Laptop's changes (newer timestamps) win
- Phone's changes are preserved if they're newer

### 4. Large Dataset (>10MB JSON)

**Scenario**: Database grows large, `db.json` becomes slow to download/upload.

**Handling**:
- Split into per-collection files
- Implement incremental sync (only push changed docs)
- Compress with gzip before push
- Use GitHub's Git Data API for blob storage

### 5. Rate Limit Exceeded

**Scenario**: App makes too many API calls and hits the 5,000/hr limit.

**Handling**:
- Check `X-RateLimit-Remaining` header on every response
- If < 100 remaining, slow down sync frequency
- Queue non-urgent syncs
- Show warning in UI

### 6. Token Expired or Revoked

**Scenario**: GitHub PAT expires or is revoked.

**Handling**:
- Catch 401 errors
- Show "Re-authenticate with GitHub" prompt
- Provide a UI for entering a new token

### 7. Corrupted db.json

**Scenario**: `db.json` gets corrupted (bad merge, manual edit, etc.).

**Handling**:
- Validate JSON before parsing
- If invalid, keep local data and overwrite remote
- Keep last 5 good versions in Git history for recovery

---

## 15. Alternative Approaches

### Approach A: GitHub Gist (Simpler)

Instead of a full repo, use a **GitHub Gist** to store the database:

```javascript
// Using Gist API
const { data } = await octokit.gists.get({ gist_id: 'YOUR_GIST_ID' })
const dbContent = JSON.parse(data.files['db.json'].content)
```

**Pros**: Simpler API, no repo management
**Cons**: No directory structure, no file storage, 10MB limit per gist

### Approach B: GitHub Actions + Scheduled Sync

Use GitHub Actions to periodically sync data:

```yaml
# .github/workflows/sync.yml
name: Database Sync
on:
  schedule:
    - cron: '*/30 * * * *'  # Every 30 minutes
  workflow_dispatch:  # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Sync database
        run: |
          # Custom sync script
          node sync.js
```

**Pros**: Server-side processing, no client-side API calls
**Cons**: More complex, 30-minute minimum interval

### Approach C: IPFS + GitHub (Decentralized)

Use **IPFS** (InterPlanetary File System) for data storage and GitHub for metadata:

1. Store data on IPFS (free, decentralized)
2. Store IPFS hash on GitHub (small, fast)
3. Pin data on a free IPFS pinning service

**Pros**: Truly decentralized, no rate limits
**Cons**: Slower, more complex, IPFS gateways may go down

### Approach D: Cloudflare Workers + GitHub

Use a **Cloudflare Worker** (free tier: 100k requests/day) as a proxy:

1. App talks to Cloudflare Worker
2. Worker reads/writes to GitHub API
3. Worker handles caching, rate limiting, and conflict resolution

**Pros**: Server-side logic, caching, better rate limit management
**Cons**: Adds a dependency on Cloudflare

---

## Quick Start Checklist

- [ ] Create a **private GitHub repository** (e.g., `my-app-db`)
- [ ] Generate a **fine-grained PAT** with contents read/write access
- [ ] Install `@octokit/rest` in your project
- [ ] Copy the `GitHubSyncService` class into your project
- [ ] Initialize the service on app start with the PAT
- [ ] Implement `pull()` on startup to sync remote data
- [ ] Implement `push()` after local data changes (debounced)
- [ ] Add a **sync status indicator** in the UI
- [ ] Handle **offline mode** (queue changes, retry when online)
- [ ] Test with **two devices** making concurrent changes
- [ ] Add **error handling** for rate limits, auth failures, and conflicts

---

## Resources

- [GitHub REST API Documentation](https://docs.github.com/en/rest)
- [@octokit/rest npm package](https://www.npmjs.com/package/@octokit/rest)
- [Dexie.js Documentation](https://dexie.org/)
- [GitHub Personal Access Tokens](https://github.com/settings/tokens)
- [GitHub OAuth Apps](https://docs.github.com/en/apps/oauth-apps)

---

*Created: July 27, 2026*
*License: MIT — Free to use, modify, and share*