/**
 * GitterSync — Token Encryption Utility
 *
 * Encrypts/decrypts the GitHub PAT using the Web Crypto API
 * with a user-provided passphrase. Uses PBKDF2 for key derivation
 * and AES-GCM for encryption.
 */

/**
 * Encrypted token blob — safe to store in localStorage.
 */
export interface EncryptedToken {
    /** Base64-encoded salt used for PBKDF2 key derivation */
    salt: string;
    /** Base64-encoded IV used for AES-GCM */
    iv: string;
    /** Base64-encoded encrypted data */
    data: string;
}

/**
 * Encrypt a string using AES-GCM with a passphrase.
 *
 * Key derivation: PBKDF2 with 600,000 iterations and SHA-256.
 * Encryption: AES-256-GCM with a random 96-bit IV.
 *
 * @param plaintext - The string to encrypt (e.g., a GitHub PAT)
 * @param passphrase - User-provided passphrase
 * @returns Encrypted token blob safe for storage
 */
export async function encrypt(plaintext: string, passphrase: string): Promise<EncryptedToken> {
    const enc = new TextEncoder();

    // Derive key from passphrase using PBKDF2
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );

    const salt = new Uint8Array(crypto.getRandomValues(new Uint8Array(16)));
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 600000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt'],
    );

    // Encrypt with AES-GCM
    const iv = new Uint8Array(crypto.getRandomValues(new Uint8Array(12)));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
        key,
        enc.encode(plaintext),
    );

    return {
        salt: uint8ArrayToBase64(salt),
        iv: uint8ArrayToBase64(iv),
        data: uint8ArrayToBase64(new Uint8Array(encrypted)),
    };
}

/**
 * Decrypt a string using AES-GCM with a passphrase.
 *
 * @param encrypted - The encrypted token blob
 * @param passphrase - User-provided passphrase (must match the one used for encryption)
 * @returns The decrypted plaintext string
 * @throws Error if decryption fails (wrong passphrase or corrupted data)
 */
export async function decrypt(encrypted: EncryptedToken, passphrase: string): Promise<string> {
    const enc = new TextEncoder();

    // Derive key from passphrase using the same salt
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );

    const salt = base64ToUint8Array(encrypted.salt);
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 600000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
    );

    // Decrypt with AES-GCM
    const iv = base64ToUint8Array(encrypted.iv);
    const data = base64ToUint8Array(encrypted.data);

    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
            key,
            data.buffer as ArrayBuffer,
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        throw new Error('Decryption failed — wrong passphrase or corrupted data');
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ─── Token Storage ────────────────────────────────────────────────────────

const STORAGE_KEY = 'gittersync_encrypted_token';

/**
 * Store an encrypted token in localStorage.
 */
export async function storeToken(token: string, passphrase: string): Promise<void> {
    const encrypted = await encrypt(token, passphrase);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
}

/**
 * Retrieve and decrypt a token from localStorage.
 *
 * @returns The decrypted token, or null if no token is stored
 * @throws Error if decryption fails (wrong passphrase)
 */
export async function retrieveToken(passphrase: string): Promise<string | null> {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const encrypted: EncryptedToken = JSON.parse(stored);
    return decrypt(encrypted, passphrase);
}

/**
 * Check if an encrypted token exists in localStorage.
 */
export function hasStoredToken(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Remove the stored encrypted token from localStorage.
 */
export function clearStoredToken(): void {
    localStorage.removeItem(STORAGE_KEY);
}
