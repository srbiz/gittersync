import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    // The demo apps import the library by its package name; point that at the
    // sources so demo components can be unit-tested without a build step.
    // (demo-vue has its own vitest project — see demo-vue/vitest.config.ts.)
    resolve: {
        alias: {
            gittersync: path.resolve(__dirname, 'src/index.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        // Coverage configuration
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/index.ts'],
        },
    },
})
