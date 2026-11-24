/**
 * Package smoke test — verifies the *built* package loads in Node.js ESM.
 *
 * Regression test for https://github.com/srbiz/gittersync/issues/3:
 * `package.json` sets `"type": "module"` and points `exports["."].import`
 * at `./dist/index.js`, so every relative specifier in `dist/*.js` must
 * carry an explicit `.js` extension (Node ESM has no extension searching —
 * https://nodejs.org/api/esm.html#mandatory-file-extensions). The same
 * applies to `dist/*.d.ts`, otherwise TypeScript consumers using
 * `moduleResolution: "node16"` / `"nodenext"` fail with TS2835.
 *
 * This script therefore checks, in order:
 *   1. `dist/` exists and the `exports["."]` targets are present.
 *   2. Every relative import/export specifier in the `src` TypeScript
 *      sources, `dist/*.js` and `dist/*.d.ts` ends with `.js`. (The root
 *      `tsconfig.json` uses `module/moduleResolution: "NodeNext"`, so
 *      `tsc` itself also rejects extensionless specifiers — this check
 *      guards the emitted files, which is what consumers actually load.)
 *   3. `import 'gittersync'` (via the package's own `exports`, i.e. the
 *      same resolution a consumer gets) succeeds in Node and `LocalDB`
 *      works against `fake-indexeddb`, as documented in `docs/api.md`
 *      ("Testing in Node").
 *
 * Run via `npm run test:package` (builds first) or directly after a build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

// ─── 1. dist/ and exports targets ────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exportTargets = Object.values(pkg.exports?.['.'] ?? {}).filter(
    (target) => typeof target === 'string' && target.startsWith('./'),
);
if (exportTargets.length === 0) {
    throw new Error('package.json must define exports["."] targets');
}
for (const target of exportTargets) {
    if (!existsSync(join(root, target))) {
        throw new Error(
            `exports target ${target} does not exist — run \`npm run build\` first ` +
                '(or use `npm run test:package`)',
        );
    }
}

// ─── 2. Explicit .js extensions on relative specifiers ───────────────────────

// Matches `from './x'`, side-effect `import './x'` and dynamic `import('./x')`.
const SPECIFIER_RE =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            yield* walk(full);
        } else {
            yield full;
        }
    }
}

const filesToCheck = [
    ...walk(join(root, 'src')).filter((file) => file.endsWith('.ts')),
    ...readdirSync(distDir)
        .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
        .map((file) => join(distDir, file)),
];

const violations = [];
for (const file of filesToCheck) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(SPECIFIER_RE)) {
        const specifier = match[1];
        if (!specifier.endsWith('.js')) {
            violations.push(`${relative(root, file)}: '${specifier}'`);
        }
    }
}
if (violations.length > 0) {
    throw new Error(
        'Relative specifiers without an explicit .js extension ' +
            '(Node ESM / TS2835 regression):\n  ' +
            violations.join('\n  '),
    );
}

// ─── 3. The built package loads and works in Node ESM ────────────────────────

await import('fake-indexeddb/auto');
const { LocalDB, mergeDocument } = await import('gittersync');

const db = new LocalDB();
try {
    await db.init();
    await db.registerCollection('package-smoke');
    if (!db.isCollectionRegistered('package-smoke')) {
        throw new Error('LocalDB package smoke test failed to register a collection');
    }

    if (typeof mergeDocument !== 'function') {
        throw new Error('Expected mergeDocument export from the built package');
    }
} finally {
    await db.close();
}

console.log(
    `package-smoke: OK (${filesToCheck.length} files checked for .js extensions, ` +
        'built package imports and LocalDB works in Node ESM)',
);
