/**
 * GitterSync — Integration Test Setup
 *
 * Provides helpers to create and delete isolated GitHub targets for
 * integration testing. Requires the GITTERSYNC_TEST_TOKEN environment
 * variable to be set with a GitHub Personal Access Token that has
 * `repo` and `delete_repo` scopes.
 *
 * Two modes are supported:
 *
 * 1. **Ephemeral repo mode** (default) — a temporary `gittersync-test-*`
 *    repository is created for the run and deleted afterwards.
 *
 * 2. **Scratch branch mode** — set `GITTERSYNC_TEST_REPO=owner/repo` to run
 *    against an existing repository. A uniquely named scratch branch
 *    (`gittersync-e2e-<timestamp>-<rand>`) is created off the default branch
 *    and deleted afterwards. `main` is never written to. This mode works with
 *    tokens that cannot create repositories (e.g. GitHub App installations or
 *    fine-grained tokens scoped to a single repo).
 */

import { Octokit } from '@octokit/rest';

const TEST_TOKEN = process.env.GITTERSYNC_TEST_TOKEN;
const REPO_PREFIX = 'gittersync-test-';
const BRANCH_PREFIX = 'gittersync-e2e-';

/** Everything a test needs to talk to an isolated sync target. */
export interface TestTarget {
    owner: string;
    repo: string;
    /** Branch the sync service should use. */
    branch: string;
    /** True when the harness created a throwaway repository for this run. */
    ephemeralRepo: boolean;
    /** Default branch of the repository (never written to). */
    defaultBranch: string;
}

let octokit: Octokit;
let owner: string;

/**
 * Initialize Octokit with the test token and resolve the authenticated user.
 * Throws if GITTERSYNC_TEST_TOKEN is not set.
 */
export async function getOctokit(): Promise<{ octokit: Octokit; owner: string }> {
    if (!TEST_TOKEN) {
        throw new Error(
            'GITTERSYNC_TEST_TOKEN environment variable is required for integration tests.\n' +
                'Set it to a GitHub PAT with `repo` and `delete_repo` scopes.',
        );
    }

    if (octokit && owner) {
        return { octokit, owner };
    }

    octokit = new Octokit({ auth: TEST_TOKEN });
    const { data } = await octokit.users.getAuthenticated();
    owner = data.login;

    return { octokit, owner };
}

/**
 * Generate a unique repo name with the gittersync-test- prefix.
 */
export function generateRepoName(): string {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `${REPO_PREFIX}${timestamp}-${rand}`;
}

/**
 * Generate a unique scratch branch name.
 */
export function generateBranchName(): string {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `${BRANCH_PREFIX}${timestamp}-${rand}`;
}

/**
 * Acquire an isolated target for integration tests.
 *
 * - When `GITTERSYNC_TEST_REPO` is set (`owner/repo`), creates a scratch branch
 *   off that repo's default branch and returns it. The repo itself is left alone.
 * - Otherwise creates a temporary public repository (original behaviour).
 */
export async function acquireTestTarget(): Promise<TestTarget> {
    const requested = process.env.GITTERSYNC_TEST_REPO?.trim();

    if (requested) {
        const [repoOwner, repoName] = requested.split('/');
        if (!repoOwner || !repoName) {
            throw new Error(
                `GITTERSYNC_TEST_REPO must be in "owner/repo" form, got "${requested}"`,
            );
        }

        const { octokit: okit } = await getOctokit();
        const { data: repo } = await okit.repos.get({ owner: repoOwner, repo: repoName });
        const defaultBranch = repo.default_branch;
        const branch = generateBranchName();

        const { data: base } = await okit.repos.getBranch({
            owner: repoOwner,
            repo: repoName,
            branch: defaultBranch,
        });

        await okit.git.createRef({
            owner: repoOwner,
            repo: repoName,
            ref: `refs/heads/${branch}`,
            sha: base.commit.sha,
        });

        console.log(
            `[integration] Using scratch branch ${repoOwner}/${repoName}@${branch} (off ${defaultBranch})`,
        );

        // Guard: the scratch branch must start clean so "empty repo" assertions hold.
        const existing = await listRemotePaths({ owner: repoOwner, repo: repoName, branch });
        const dirty = existing.filter((p) =>
            ['meta.json', 'collections/', 'changelog/', 'files/'].some((prefix) =>
                p.startsWith(prefix),
            ),
        );
        if (dirty.length > 0) {
            await releaseTestTarget({
                owner: repoOwner,
                repo: repoName,
                branch,
                ephemeralRepo: false,
                defaultBranch,
            });
            throw new Error(
                `Scratch branch ${branch} is not a clean sync target — found: ${dirty.join(', ')}`,
            );
        }

        return { owner: repoOwner, repo: repoName, branch, ephemeralRepo: false, defaultBranch };
    }

    const { owner: own, repo } = await createTempRepo();
    const { octokit: okit } = await getOctokit();
    const { data: repoData } = await okit.repos.get({ owner: own, repo });

    return {
        owner: own,
        repo,
        branch: repoData.default_branch,
        ephemeralRepo: true,
        defaultBranch: repoData.default_branch,
    };
}

/**
 * Release a target acquired with {@link acquireTestTarget}.
 * Deletes the scratch branch, or the whole temp repo in ephemeral mode.
 */
export async function releaseTestTarget(target: TestTarget): Promise<void> {
    if (target.ephemeralRepo) {
        await deleteTempRepo(target.owner, target.repo);
        return;
    }

    const { octokit: okit } = await getOctokit();

    if (target.branch === target.defaultBranch || !target.branch.startsWith(BRANCH_PREFIX)) {
        throw new Error(
            `Refusing to delete branch "${target.branch}" — only "${BRANCH_PREFIX}*" scratch branches are eligible`,
        );
    }

    try {
        await okit.git.deleteRef({
            owner: target.owner,
            repo: target.repo,
            ref: `heads/${target.branch}`,
        });
        console.log(`[integration] Deleted scratch branch ${target.branch}`);
    } catch (error: any) {
        if (error?.status === 404 || error?.status === 422) {
            console.log(`[integration] Scratch branch ${target.branch} already gone`);
            return;
        }
        console.error(`[integration] Failed to delete branch ${target.branch}:`, error);
    }
}

/**
 * List all file paths in a branch (recursive). Used by tests to inspect
 * exactly what the sync engine wrote to the remote.
 */
export async function listRemotePaths(target: {
    owner: string;
    repo: string;
    branch: string;
}): Promise<string[]> {
    const { octokit: okit } = await getOctokit();

    try {
        const { data: tree } = await okit.git.getTree({
            owner: target.owner,
            repo: target.repo,
            tree_sha: target.branch,
            recursive: 'true',
        });
        return (tree.tree ?? [])
            .filter((entry) => entry.type === 'blob' && entry.path)
            .map((entry) => entry.path!);
    } catch (error: any) {
        if (error?.status === 404 || error?.status === 409) return []; // empty branch
        throw error;
    }
}

/**
 * Read a file's raw text content from the remote branch.
 * Returns null when the file does not exist.
 */
export async function readRemoteText(target: TestTarget, path: string): Promise<string | null> {
    const { octokit: okit } = await getOctokit();

    try {
        const { data } = await okit.repos.getContent({
            owner: target.owner,
            repo: target.repo,
            path,
            ref: target.branch,
        });
        if (Array.isArray(data) || !('content' in data)) return null;
        return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    } catch (error: any) {
        if (error?.status === 404) return null;
        throw error;
    }
}

/**
 * Create a temporary public repository for testing.
 * Returns the repo full name (`owner/repo`).
 */
export async function createTempRepo(): Promise<{ owner: string; repo: string }> {
    const { octokit: okit, owner: own } = await getOctokit();
    const repo = generateRepoName();

    await okit.repos.createForAuthenticatedUser({
        name: repo,
        private: false,
        auto_init: true, // Initialize with a README so main branch exists
    });

    console.log(`[integration] Created repo: ${own}/${repo}`);
    return { owner: own, repo };
}

/**
 * Delete a temporary repository. Called in afterAll() to clean up.
 */
export async function deleteTempRepo(owner: string, repo: string): Promise<void> {
    const { octokit: okit } = await getOctokit();

    try {
        await okit.repos.delete({ owner, repo });
        console.log(`[integration] Deleted repo: ${owner}/${repo}`);
    } catch (error) {
        console.error(`[integration] Failed to delete repo ${owner}/${repo}:`, error);
    }
}

/**
 * Clean up any leftover test repos that may not have been deleted
 * (e.g., if a test was interrupted). Deletes repos older than 1 hour.
 * Only applies to ephemeral-repo mode; scratch branches are skipped.
 */
export async function cleanupStaleRepos(): Promise<void> {
    // Scratch-branch mode does not create repositories, and listing them may
    // require permissions the token does not have — skip instead of failing.
    if (process.env.GITTERSYNC_TEST_REPO?.trim()) return;

    const { octokit: okit, owner: own } = await getOctokit();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    try {
        const { data: repos } = await okit.repos.listForUser({
            username: own,
            per_page: 100,
            sort: 'created',
            direction: 'desc',
        });

        for (const repo of repos) {
            if (
                repo.name.startsWith(REPO_PREFIX) &&
                repo.created_at &&
                new Date(repo.created_at) < oneHourAgo
            ) {
                await okit.repos.delete({ owner: own, repo: repo.name });
                console.log(`[integration] Cleaned up stale repo: ${own}/${repo.name}`);
            }
        }
    } catch (error) {
        console.error('[integration] Failed to clean up stale repos:', error);
    }
}
