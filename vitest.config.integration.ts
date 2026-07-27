import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['tests/integration/**/*.test.ts'],
        testTimeout: 30_000,
        hookTimeout: 60_000,
        // No coverage for integration tests — they're slow and test real API
        coverage: {
            enabled: false,
        },
    },
});
