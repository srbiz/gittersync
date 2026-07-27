import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    base: '/gittersync/',
    root: '.',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    resolve: {
        alias: {
            gittersync: path.resolve(__dirname, '..'),
        },
    },
});