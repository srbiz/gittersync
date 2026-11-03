/**
 * GitterSync — Configuration resolution & validation tests
 */

import { describe, it, expect } from 'vitest';
import {
    resolveConfig,
    assertValidCollectionName,
    assertValidRepoPath,
    COLLECTION_NAME_PATTERN,
    DEFAULT_BRANCH,
    DEFAULT_COMPACTION_THRESHOLD,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_BASE_DELAY,
    DEFAULT_DELETE_RETENTION_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_RAW_BASE_URL,
} from '../src/config';
import { ValidationError } from '../src/types';

describe('resolveConfig — defaults', () => {
    it('fills in every documented default', () => {
        const resolved = resolveConfig({ owner: 'me', repo: 'my-data' });

        expect(resolved).toMatchObject({
            owner: 'me',
            repo: 'my-data',
            branch: DEFAULT_BRANCH,
            compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
            maxRetries: DEFAULT_MAX_RETRIES,
            retryBaseDelay: DEFAULT_RETRY_BASE_DELAY,
            deleteRetentionMs: DEFAULT_DELETE_RETENTION_MS,
            requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            rawBaseUrl: DEFAULT_RAW_BASE_URL,
            rawCacheBust: true,
            useRawContent: true,
            migrations: [],
        });
        expect(typeof resolved.onSyncStatusChange).toBe('function');
    });

    it('defaults deleteRetentionMs to 30 days', () => {
        expect(DEFAULT_DELETE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('keeps explicit options, including false and zero', () => {
        const resolved = resolveConfig({
            owner: 'me',
            repo: 'data',
            branch: 'data',
            compactionThreshold: 5,
            maxRetries: 0,
            retryBaseDelay: 0,
            deleteRetentionMs: 1000,
            useRawContent: false,
            rawCacheBust: false,
            rawBaseUrl: 'https://raw.example.com/',
        });

        expect(resolved.branch).toBe('data');
        expect(resolved.compactionThreshold).toBe(5);
        expect(resolved.maxRetries).toBe(0);
        expect(resolved.retryBaseDelay).toBe(0);
        expect(resolved.deleteRetentionMs).toBe(1000);
        expect(resolved.useRawContent).toBe(false);
        expect(resolved.rawCacheBust).toBe(false);
        expect(resolved.rawBaseUrl).toBe('https://raw.example.com');
    });

    it('trims owner, repo and branch', () => {
        const resolved = resolveConfig({ owner: '  me ', repo: ' data ', branch: '  dev ' });
        expect(resolved.owner).toBe('me');
        expect(resolved.repo).toBe('data');
        expect(resolved.branch).toBe('dev');
    });

    it('falls back to main when branch resolves to an empty string', () => {
        expect(resolveConfig({ owner: 'me', repo: 'd', branch: '   ' }).branch).toBe('main');
    });
});

describe('resolveConfig — validation', () => {
    it('requires an owner', () => {
        expect(() => resolveConfig({ owner: '', repo: 'data' })).toThrow(ValidationError);
        expect(() => resolveConfig({ owner: '  ', repo: 'data' })).toThrow(/owner/);
    });

    it('requires a repo', () => {
        expect(() => resolveConfig({ owner: 'me', repo: '' })).toThrow(/repo/);
    });

    it('rejects a missing configuration object', () => {
        expect(() => resolveConfig(undefined as never)).toThrow(ValidationError);
    });

    it('rejects non-numeric and negative tuning values', () => {
        expect(() =>
            resolveConfig({ owner: 'me', repo: 'd', compactionThreshold: 'x' as never }),
        ).toThrow(ValidationError);
        expect(() => resolveConfig({ owner: 'me', repo: 'd', compactionThreshold: 0 })).toThrow(
            /positive integer/,
        );
        expect(() => resolveConfig({ owner: 'me', repo: 'd', maxRetries: -1 })).toThrow(
            ValidationError,
        );
        expect(() => resolveConfig({ owner: 'me', repo: 'd', requestTimeoutMs: -5 })).toThrow(
            ValidationError,
        );
    });

    it('rounds fractional numbers down', () => {
        expect(
            resolveConfig({ owner: 'me', repo: 'd', compactionThreshold: 7.9 }).compactionThreshold,
        ).toBe(7);
    });
});

describe('assertValidCollectionName', () => {
    it('accepts names that are safe as filenames and table names', () => {
        for (const name of ['users', 'column_in-progress', 'tasks.v2', 'A1', 'a_b-c.d']) {
            expect(() => assertValidCollectionName(name)).not.toThrow();
        }
    });

    it('rejects empty and unsafe names', () => {
        for (const name of [
            '',
            '   ',
            'users/tasks',
            '../etc',
            'a b',
            'täst',
            'users?',
            'a'.repeat(65),
        ]) {
            expect(() => assertValidCollectionName(name)).toThrow(ValidationError);
        }
    });

    it('rejects names that do not start with a letter or digit', () => {
        expect(() => assertValidCollectionName('_private')).toThrow(ValidationError);
        expect(() => assertValidCollectionName('.hidden')).toThrow(ValidationError);
        expect(COLLECTION_NAME_PATTERN.test('_private')).toBe(false);
    });
});

describe('assertValidRepoPath', () => {
    it('accepts repository-relative paths', () => {
        for (const path of [
            'meta.json',
            'collections/users.json',
            'files/task-1/photo (1).png',
            'changelog/2026-07-27T10-00-00-000Z_device.json',
        ]) {
            expect(() => assertValidRepoPath(path)).not.toThrow();
        }
    });

    it('rejects absolute paths, traversal and empty segments', () => {
        for (const path of [
            '/meta.json',
            '../meta.json',
            'collections//users.json',
            'a/./b',
            'a/../b',
            '',
        ]) {
            expect(() => assertValidRepoPath(path)).toThrow(ValidationError);
        }
    });

    it('rejects backslashes and control characters', () => {
        expect(() => assertValidRepoPath('collections\\users.json')).toThrow(ValidationError);
        expect(() => assertValidRepoPath('collections/us\u0000ers.json')).toThrow(ValidationError);
    });
});
