import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Deployed next to the kanban demo: https://srbiz.github.io/gittersync/todo/
export default defineConfig({
    base: '/gittersync/todo/',
    plugins: [vue()],
    resolve: {
        alias: {
            '@': path.resolve(here, 'src'),
            // Use the library sources directly, exactly like the kanban demo
            gittersync: path.resolve(here, '..'),
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
