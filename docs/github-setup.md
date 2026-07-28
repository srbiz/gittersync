# GitHub Setup FAQ

Common questions about setting up GitHub repositories and tokens for GitterSync.

---

## Do I need to create the GitHub repository manually?

**Yes.** GitterSync does **not** automatically create repositories. You must create one manually on GitHub before using it as a database:

1. Go to [github.com/new](https://github.com/new)
2. Choose a name (e.g., `my-app-data`)
3. Set visibility to **Private** or **Public** (private is recommended for production)
4. Click **Create repository**
5. Pass the `owner` and `repo` to `GitHubSyncService`

```typescript
const sync = new GitHubSyncService({
  owner: 'your-username',
  repo: 'my-app-data',   // must already exist
})
```

> The integration tests in `tests/integration/` create temporary repos programmatically,
> but that's test-only code — not part of the published library.

---

## Can I use a private repository?

**Yes.** Private repositories work with no library changes. Your PAT just needs the
`repo` scope (which grants access to private repos owned by you).

```typescript
const sync = new GitHubSyncService({
  owner: 'your-username',
  repo: 'my-private-app-data',
})
```

GitterSync stores data as JSON files — contents are visible on github.com to anyone
with repo access. For sensitive data, use a private repo and optionally enable
end-to-end encryption (see `plans/remaining-features.md` Phase 4).

### Public vs Private

| Aspect | Public | Private |
|--------|--------|---------|
| Visibility | Anyone can view files | Only you + collaborators |
| PAT scope | `repo` or fine-grained `Contents` | `repo` (full private access) |
| GitHub Pages demo | Works | Doesn't work (no public URL) |
| Use case | Demos, open-source apps | Production, sensitive data |

---

## Can I use the same PAT for multiple database repositories?

**Yes.** A PAT is account-scoped, not repo-scoped. One token works across all repos
your token has access to:

```typescript
const token = 'ghp_your_token_here'

const db1 = new GitHubSyncService({ owner: 'you', repo: 'app-data' })
const db2 = new GitHubSyncService({ owner: 'you', repo: 'app-backup' })
const db3 = new GitHubSyncService({ owner: 'org', repo: 'shared-data' })

await db1.init(token)
await db2.init(token)
await db3.init(token)
```

Each `GitHubSyncService` instance maintains its own:
- Local Dexie database (separate IndexedDB data per instance)
- Sync cursor (tracks last synced commit per repo)
- Changelog queue (pending local changes per repo)

---

## What PAT scopes are required?

### Classic Token

| Scope | Required For |
|-------|-------------|
| `repo` | Private repos + full access to public repos |

The `repo` scope is sufficient for all GitterSync operations: reading/writing
files, comparing commits, checking repo size, uploading binaries.

### Fine-grained Token

| Permission | Access Level | Required For |
|------------|-------------|-------------|
| Contents | Read and write | Reading/writing collection files, changelogs, meta.json |
| Metadata | Read-only | Repo size, commit comparisons |

Fine-grained tokens are more secure because they're scoped to specific repos,
but classic tokens are simpler for getting started.

---

## Where do I create the PAT?

1. **Classic token**: [github.com/settings/tokens](https://github.com/settings/tokens)
   - Click **Generate new token (classic)**
   - Select `repo` scope
   - Copy the token immediately — it's shown only once

2. **Fine-grained token**: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   - Select the repository you want to use as a database
   - Grant **Contents: Read and write** + **Metadata: Read-only**
   - Create and copy the token

---

## What happens if the repo doesn't exist?

`init()` calls `octokit.repos.get()` to verify the repo exists and is accessible.
If the repo doesn't exist, or the token lacks access, an `AuthError` is thrown:

```typescript
try {
  await sync.init(token)
} catch (err) {
  if (err instanceof AuthError) {
    // Repo doesn't exist, or token lacks access
    console.error('Check repo name and token permissions')
  }
}
```

---

## Can multiple apps share the same database repo?

**Yes.** Multiple apps (or multiple instances of the same app) can point to the
same GitHub repo. Each instance:
- Has its own local Dexie database
- Tracks its own sync cursor
- Pushes its own changelogs
- Pulls changes from other instances via the Compare Commits API

This is the multi-device scenario — the field-level LWW merge algorithm handles
concurrent edits from different devices.
