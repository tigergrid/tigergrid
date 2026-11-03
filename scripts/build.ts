#!/usr/bin/env bun
// Compile tigergrid into standalone executables (no Bun needed to run them) and write
// SHA256SUMS next to them. Usage: `bun run build` for every target, or
// `bun scripts/build.ts bun-linux-x64` for a subset (CI builds one per runner).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BunPlugin } from 'bun';

const TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64'] as const;
type Target = (typeof TARGETS)[number];
const OUT_DIR = 'dist';

// Ink dynamically imports react-devtools-core when DEV=true. Neither CLI flag handles that:
// Bun resolves the import before dropping the dead branch (so the build fails), and
// `--external` hoists it into a top-level import (so the output fails at startup). Resolving
// it to an empty module works; the DEV define makes the branch dead anyway, so a user's
// DEV=true does nothing.
const stubDevtools: BunPlugin = {
	name: 'stub-react-devtools-core',
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
	}
};

/**
 * Run a command and fail loudly with its stderr if it exits non-zero.
 *
 * @returns the command's trimmed stdout.
 * Called by: buildCommit.
 * Calls: Bun.spawnSync.
 */
function run(cmd: string[]): string {
	const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed:\n${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/**
 * Identify the source a binary is built from: the short commit hash, marked `-dirty` when the
 * working tree has uncommitted changes, so a binary never claims to be a commit it isn't.
 *
 * @returns e.g. `3d9b5ea` or `3d9b5ea-dirty`.
 * Called by: module top level.
 * Calls: run.
 */
function buildCommit(): string {
	const commit = run(['git', 'rev-parse', '--short', 'HEAD']);
	return run(['git', 'status', '--porcelain']) ? `${commit}-dirty` : commit;
}

/**
 * Compile the CLI for one target. The commit is baked in through `process.env.TIGERGRID_COMMIT`
 * (read by `--version`), and the binary ignores `.env` and `bunfig.toml` files in whatever
 * directory it runs from. Uses the Bun.build API rather than `bun build`, because the
 * react-devtools-core stub is a plugin.
 *
 * @returns the output path, e.g. `dist/tigergrid-linux-x64`.
 * Called by: module top level.
 * Calls: Bun.build.
 */
async function compile(target: Target, commit: string): Promise<string> {
	const outfile = join(OUT_DIR, `tigergrid-${target.replace(/^bun-/, '')}`);
	const result = await Bun.build({
		entrypoints: ['src/cli.ts'],
		compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
		define: { 'process.env.DEV': JSON.stringify('false'), 'process.env.TIGERGRID_COMMIT': JSON.stringify(commit) },
		plugins: [stubDevtools]
	});
	if (!result.success) throw new AggregateError(result.logs, `build for ${target} failed`);
	return outfile;
}

/**
 * Hash a file the way `sha256sum` does.
 *
 * @returns the lowercase hex SHA-256 of the file's bytes.
 * Called by: module top level.
 * Calls: Bun.file().arrayBuffer, Bun.CryptoHasher.
 */
async function sha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(await Bun.file(path).arrayBuffer());
	return hasher.digest('hex');
}

/**
 * Check that a command-line argument names a supported target.
 *
 * @returns true (narrowing the type) for one of TARGETS.
 * Called by: module top level.
 * Calls: nothing.
 */
const isTarget = (value: string): value is Target => TARGETS.some((target) => target === value);

const requested = process.argv.slice(2);
const unknown = requested.filter((target) => !isTarget(target));
if (unknown.length) throw new Error(`unknown target(s): ${unknown.join(', ')}; supported: ${TARGETS.join(', ')}`);
const targets = requested.length ? requested.filter(isTarget) : TARGETS;

mkdirSync(OUT_DIR, { recursive: true });
const commit = buildCommit();
const lines: string[] = [];
for (const target of targets) {
	const outfile = await compile(target, commit);
	const name = outfile.slice(OUT_DIR.length + 1);
	lines.push(`${await sha256(outfile)}  ${name}`);
	console.log(`built ${outfile} (${commit})`);
}
await Bun.write(join(OUT_DIR, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`wrote ${join(OUT_DIR, 'SHA256SUMS')}`);
