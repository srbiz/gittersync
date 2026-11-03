/**
 * Thin connection layer around the GitterSync library.
 *
 * The Pinia store owns *what* to do; this module owns *how* to reach GitHub:
 * repository config, encrypted token storage and the sync service lifecycle.
 */
import { GitHubSyncService, storeToken, retrieveToken, hasStoredToken, clearStoredToken } from 'gittersync';
import type { SyncStatus } from 'gittersync';

const CONFIG_KEY = 'gittersync-todo-vue-config';

/**
 * The passphrase is kept in sessionStorage (this tab only) so a page reload can
 * unlock the encrypted token without ever writing the secret to disk. Close the
 * tab and the passphrase is gone — the encrypted blob stays useless without it.
 */
const PASSPHRASE_KEY = 'gittersync-todo-vue-passphrase';

const DEFAULT_BRANCH = 'main';

export interface StoredConfig {
    owner: string;
    repo: string;
    branch: string;
}

export function loadConfig(): StoredConfig | null {
    try {
        const raw = sessionStorage.getItem(CONFIG_KEY) ?? localStorage.getItem(CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredConfig>;
        if (!parsed.owner || !parsed.repo) return null;
        return {
            owner: String(parsed.owner),
            repo: String(parsed.repo),
            branch: String(parsed.branch || DEFAULT_BRANCH),
        };
    } catch {
        return null;
    }
}

export function persistConfig(config: StoredConfig, remember: boolean): void {
    const raw = JSON.stringify(config);
    if (remember) {
        localStorage.setItem(CONFIG_KEY, raw);
        sessionStorage.removeItem(CONFIG_KEY);
    } else {
        sessionStorage.setItem(CONFIG_KEY, raw);
        localStorage.removeItem(CONFIG_KEY);
    }
}

export function rememberPassphrase(passphrase: string): void {
    sessionStorage.setItem(PASSPHRASE_KEY, passphrase);
}

export function rememberedPassphrase(): string | null {
    return sessionStorage.getItem(PASSPHRASE_KEY);
}

export function canReconnect(): boolean {
    return hasStoredToken() && loadConfig() !== null && rememberedPassphrase() !== null;
}

export function forgetConnection(): void {
    clearStoredToken();
    localStorage.removeItem(CONFIG_KEY);
    sessionStorage.removeItem(CONFIG_KEY);
    sessionStorage.removeItem(PASSPHRASE_KEY);
}

/**
 * Generate a strong random passphrase for token encryption.
 *
 * The passphrase is what makes the stored token useless to anyone who can read
 * localStorage, so it must never be derived from the repository name.
 */
export function generatePassphrase(words = 4): string {
    const cryptoApi = globalThis.crypto;
    const bytes = new Uint8Array(words * 3);
    if (cryptoApi?.getRandomValues) {
        cryptoApi.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').replace(/(.{6})/g, '$1-').slice(0, -1);
}

/**
 * Create and initialise a sync service for a repository.
 *
 * The token is encrypted with the passphrase before it is written to
 * localStorage; the plaintext never leaves this function.
 */
export async function createService(
    config: StoredConfig,
    token: string,
    passphrase: string,
    collections: string[],
    onStatus: (status: SyncStatus) => void,
): Promise<GitHubSyncService> {
    await storeToken(token, passphrase);

    const service = new GitHubSyncService({
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        // Reads go through raw.githubusercontent.com, which is not part of the
        // hourly API budget — essential for a demo that may be reloaded often.
        useRawContent: true,
        onSyncStatusChange: onStatus,
    });

    await service.init(token);
    // Collections must be registered before the first read or write: each one
    // becomes collections/<name>.json remotely and an IndexedDB table locally.
    await service.registerCollections(collections);
    return service;
}

/** Reconnect using the encrypted token from a previous visit in this tab. */
export async function reconnectService(
    collections: string[],
    onStatus: (status: SyncStatus) => void,
): Promise<GitHubSyncService | null> {
    const config = loadConfig();
    const passphrase = rememberedPassphrase();
    if (!config || !passphrase || !hasStoredToken()) return null;

    const token = await retrieveToken(passphrase);
    if (!token) return null;
    return createService(config, token, passphrase, collections, onStatus);
}
