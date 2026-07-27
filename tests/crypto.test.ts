/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    encrypt,
    decrypt,
    storeToken,
    retrieveToken,
    hasStoredToken,
    clearStoredToken,
} from '../src/crypto';
import type { EncryptedToken } from '../src/crypto';

// ─── encrypt / decrypt ──────────────────────────────────────────────────────

describe('encrypt', () => {
    it('produces an EncryptedToken with salt, iv, and data', async () => {
        const result = await encrypt('hello', 'passphrase');

        expect(result).toHaveProperty('salt');
        expect(result).toHaveProperty('iv');
        expect(result).toHaveProperty('data');
        expect(typeof result.salt).toBe('string');
        expect(typeof result.iv).toBe('string');
        expect(typeof result.data).toBe('string');
    });

    it('produces different ciphertext for the same input (random salt/IV)', async () => {
        const result1 = await encrypt('hello', 'passphrase');
        const result2 = await encrypt('hello', 'passphrase');

        // Extremely unlikely to be equal due to random salt and IV
        expect(result1.salt).not.toBe(result2.salt);
        expect(result1.iv).not.toBe(result2.iv);
        expect(result1.data).not.toBe(result2.data);
    });
});

describe('decrypt', () => {
    it('round-trips encrypt → decrypt', async () => {
        const plaintext = 'my-secret-token';
        const encrypted = await encrypt(plaintext, 'mypassphrase');
        const decrypted = await decrypt(encrypted, 'mypassphrase');

        expect(decrypted).toBe(plaintext);
    });

    it('throws on wrong passphrase', async () => {
        const encrypted = await encrypt('secret', 'correct-passphrase');

        await expect(decrypt(encrypted, 'wrong-passphrase')).rejects.toThrow('Decryption failed');
    });

    it('throws on corrupted data', async () => {
        const encrypted = await encrypt('secret', 'passphrase');

        const corrupted: EncryptedToken = {
            ...encrypted,
            data: 'aW52YWxpZGJhc2U2NA==', // "invalidbase64" in base64
        };

        await expect(decrypt(corrupted, 'passphrase')).rejects.toThrow();
    });

    it('handles empty string plaintext', async () => {
        const encrypted = await encrypt('', 'passphrase');
        const decrypted = await decrypt(encrypted, 'passphrase');

        expect(decrypted).toBe('');
    });

    it('handles unicode plaintext', async () => {
        const plaintext = 'こんにちは世界 🌍';
        const encrypted = await encrypt(plaintext, 'passphrase');
        const decrypted = await decrypt(encrypted, 'passphrase');

        expect(decrypted).toBe(plaintext);
    });

    it('handles long plaintext', async () => {
        const plaintext = 'x'.repeat(10_000);
        const encrypted = await encrypt(plaintext, 'passphrase');
        const decrypted = await decrypt(encrypted, 'passphrase');

        expect(decrypted).toBe(plaintext);
    });
});

// ─── Token Storage ──────────────────────────────────────────────────────────

describe('storeToken / retrieveToken', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('stores and retrieves a token', async () => {
        await storeToken('ghp_abc123', 'mypassphrase');
        const token = await retrieveToken('mypassphrase');

        expect(token).toBe('ghp_abc123');
    });

    it('returns null when no token is stored', async () => {
        const token = await retrieveToken('mypassphrase');
        expect(token).toBeNull();
    });

    it('throws on wrong passphrase when retrieving', async () => {
        await storeToken('ghp_abc123', 'correct-passphrase');

        await expect(retrieveToken('wrong-passphrase')).rejects.toThrow('Decryption failed');
    });
});

describe('hasStoredToken', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('returns false when no token is stored', () => {
        expect(hasStoredToken()).toBe(false);
    });

    it('returns true after storing a token', async () => {
        await storeToken('ghp_abc123', 'passphrase');
        expect(hasStoredToken()).toBe(true);
    });
});

describe('clearStoredToken', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('removes the stored token', async () => {
        await storeToken('ghp_abc123', 'passphrase');
        expect(hasStoredToken()).toBe(true);

        clearStoredToken();
        expect(hasStoredToken()).toBe(false);
    });

    it('is a no-op when no token is stored', () => {
        expect(() => clearStoredToken()).not.toThrow();
        expect(hasStoredToken()).toBe(false);
    });
});
