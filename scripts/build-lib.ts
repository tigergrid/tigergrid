#!/usr/bin/env bun
// Build the npm package into dist/lib: the parsers (src/index.ts) bundled for Node.js as
// index.js, and their type declarations under types/. The CLI and the TUI ship as the
// standalone binaries instead (scripts/build.ts).
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'dist/lib';
const TYPES_DIR = join(OUT_DIR, 'types');

await rm(OUT_DIR, { recursive: true, force: true });
const result = await Bun.build({ entrypoints: ['src/index.ts'], target: 'node', outdir: OUT_DIR, naming: 'index.js' });
if (!result.success) throw new AggregateError(result.logs, 'library build failed');

const tsc = Bun.spawnSync(['node_modules/.bin/tsc', '-p', 'tsconfig.lib.json'], {
	stdout: 'inherit',
	stderr: 'inherit'
});
if (tsc.exitCode !== 0) throw new Error('declaration build failed');

// tsc keeps the source's extensionless relative imports, which NodeNext consumers reject;
// point each at the .js file its declaration stands for.
const relative = /((?:from |import\()['"])(\.{1,2}\/[^'"]+?)(['"])/g;
for (const file of await readdir(TYPES_DIR, { recursive: true })) {
	if (!file.endsWith('.d.ts')) continue;
	const path = join(TYPES_DIR, file);
	const text = await readFile(path, 'utf8');
	await writeFile(
		path,
		text.replace(relative, (match, head: string, specifier: string, quote: string) =>
			specifier.endsWith('.js') ? match : `${head}${specifier}.js${quote}`
		)
	);
}
console.log(`built ${join(OUT_DIR, 'index.js')} and its declarations in ${TYPES_DIR}`);
