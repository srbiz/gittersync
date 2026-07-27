/**
 * GitterSync — Integration Test Setup
 *
 * Provides helpers to create and delete temporary GitHub repositories
 * for integration testing. Requires the GITTERSYNC_TEST_TOKEN environment
 * variable to be set with a GitHub Personal Access Token that has
 * `repo` and `delete_repo` scopes.
 */

import { Octokit } from '@octokit/rest';

const TEST_TOKEN = process.env.GITTERSYNC_TEST_TOKEN;
const REPO_PREFIX = 'gittersync-test-';

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
 */
export async function cleanupStaleRepos(): Promise<void> {
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
