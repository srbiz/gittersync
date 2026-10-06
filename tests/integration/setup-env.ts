/**
 * GitterSync — Integration Test Environment
 *
 * jsdom does not implement IndexedDB, so the integration suite polyfills it.
 * This file is loaded via `setupFiles` in vitest.config.integration.ts, which
 * guarantees it runs before Dexie is imported (Dexie captures the global
 * IndexedDB implementation when its module is first evaluated).
 */

import 'fake-indexeddb/auto';
