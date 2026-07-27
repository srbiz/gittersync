# Integration Tests

These tests exercise the **real GitHub API** — no mocks. They verify the full sync cycle end-to-end: init → registerCollections → pull → push → sync → compact.

## Prerequisites

1. A GitHub Personal Access Token with `repo` and `delete_repo` scopes
2. The token must be set in the `GITTERSYNC_TEST_TOKEN` environment variable

## Running

```bash
# Set the token (PowerShell)
$env:GITTERSYNC_TEST_TOKEN = "ghp_your_token_here"

# Set the token (bash/zsh)
export GITTERSYNC_TEST_TOKEN="ghp_your_token_here"

# Run integration tests
npm run test:integration
```

## What happens

1. A **temporary public repository** is created on your GitHub account with the `gittersync-test-` prefix
2. The full sync cycle is exercised against this repo
3. The repository is **deleted** in the `afterAll` cleanup hook
4. Any stale test repos (older than 1 hour) are cleaned up at the start of each run

## Safety

- Integration tests are **not** part of `npm test` — they must be explicitly invoked
- The CI workflow does **not** run integration tests (no token in CI)
- Each test creates a unique repo name with a `gittersync-test-` prefix
- All test repos are cleaned up after the run

## Troubleshooting

- **Rate limiting**: GitHub API has rate limits. If you see 403 errors, wait a few minutes and retry.
- **Leftover repos**: If a test is interrupted, stale repos may remain. Re-running the tests will clean up repos older than 1 hour. You can also delete them manually from GitHub.
