#!/usr/bin/env bun
// Compile the spike for tigergrid's three binary targets, with the same options as
// scripts/build.ts, and print each binary's size. Usage: `bun build.ts` for every target, or
// `bun build.ts bun-linux-x64` for a subset (CI builds one per runner).
import { statSync } from 'node:fs';
import type { BunPlugin } from 'bun';

const TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64'] as const;
type Target = (typeof TARGETS)[number];

const requested = process.argv.slice(2);
const unknown = requested.filter((target) => !(TARGETS as readonly string[]).includes(target));
if (unknown.length) throw new Error(`unknown target(s): ${unknown.join(', ')}; supported: ${TARGETS.join(', ')}`);
const targets = requested.length ? (requested as Target[]) : TARGETS;

// Ink dynamically imports react-devtools-core when DEV=true. Neither CLI flag handles that:
// Bun resolves the import before dropping the dead branch (so the build fails), and
// `--external` hoists it into a top-level import (so the binary fails at startup). Resolving
// it to an empty module is the one that works; the DEV define makes the branch dead anyway.
const stubDevtools: BunPlugin = {
	name: 'stub-react-devtools-core',
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
	}
};

for (const target of targets) {
	const outfile = `dist/spike-${target.replace(/^bun-/, '')}`;
	const result = await Bun.build({
		entrypoints: ['src/app.tsx'],
		compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
		define: { 'process.env.DEV': JSON.stringify('false') },
		plugins: [stubDevtools]
	});
	if (!result.success) throw new AggregateError(result.logs, `${target} failed`);
	console.log(`${outfile}  ${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB`);
}
