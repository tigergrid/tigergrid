#!/usr/bin/env bun
// Compile the spike for tigergrid's three binary targets, with the same options as
// scripts/build.ts, and print each binary's size.
import { statSync } from 'node:fs';
import type { BunPlugin } from 'bun';

const TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64'] as const;

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

for (const target of TARGETS) {
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
