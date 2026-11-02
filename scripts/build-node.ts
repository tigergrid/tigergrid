#!/usr/bin/env bun
// Build the JavaScript CLI for Node.js into dist/node/cli.js (the npm package's entry point).
// Everything is bundled, Ink and React included, so the package has no runtime dependencies.
import { DEFINE, ENTRYPOINT, PLUGINS } from './bundle';

const result = await Bun.build({
	entrypoints: [ENTRYPOINT],
	target: 'node',
	outdir: 'dist/node',
	naming: 'cli.js',
	define: DEFINE,
	plugins: PLUGINS
});
if (!result.success) throw new AggregateError(result.logs, 'Node build failed');
console.log(`built ${result.outputs.map((output) => output.path).join(', ')}`);
