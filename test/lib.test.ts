// The npm package as a consumer gets it: dist/lib (from `bun run build:lib`), imported by name
// through package.json's `exports`, run by Node.js and type-checked by a strict NodeNext
// project. `bun run test:lib` builds it and sets TIGERGRID_TEST_LIB; plain `bun test` skips it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonDay, LoadOptions } from '../types/cli';
import { loadSources } from '../src/load';
import { jsonRows } from '../src/report';
import { buildGitFixture } from './helpers/git-fixture';

const SINCE = '2016-01-01';

// Run by Node.js in the consumer: what the package exports, and what loadSources reads with
// Sets and Maps flattened the way `--json` flattens them.
const RUN = `
import * as tigergrid from 'tigergrid';
const loaded = await tigergrid.loadSources(JSON.parse(process.argv[2]), process.argv[3]);
const rows = [...loaded.days]
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([date, day]) => ({
		date,
		sessions: { claude: day.sessions.claude.size, codex: day.sessions.codex.size },
		prompts: day.prompts,
		tokens: day.tokens,
		commits: day.commits,
		aiCommits: day.aiCommits,
		projects: Object.fromEntries(day.projects)
	}));
const files = [loaded.claudeFiles, loaded.codexFiles, loaded.repos];
console.log(JSON.stringify({ exports: Object.keys(tigergrid).sort(), files, rows }));
`;

// Type-checked in the consumer, with nothing skipped, against the published declarations.
const CONSUMER = `
import { loadSources, type Day, type Days, type Loaded, type LoadOptions } from 'tigergrid';
const options: LoadOptions = { withGit: false, gitRoots: [] };
const loaded: Loaded = await loadSources(options, '2026-01-01');
const days: Days = loaded.days;
const first: Day | undefined = days.values().next().value;
console.log(first?.prompts.claude);
`;

const TSCONFIG = {
	compilerOptions: {
		module: 'nodenext',
		moduleResolution: 'nodenext',
		target: 'es2022',
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: []
	},
	files: ['index.ts']
};

describe.skipIf(process.env.TIGERGRID_TEST_LIB !== '1')('the npm package (dist/lib)', () => {
	let git: { root: string; cleanup: () => void };
	let consumer: string;
	beforeAll(() => {
		git = buildGitFixture();
		consumer = mkdtempSync(join(tmpdir(), 'tigergrid-lib-'));
		mkdirSync(join(consumer, 'node_modules'));
		symlinkSync(resolve('.'), join(consumer, 'node_modules', 'tigergrid'), 'dir');
		writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
		writeFileSync(join(consumer, 'run.mjs'), RUN);
		writeFileSync(join(consumer, 'index.ts'), CONSUMER);
		writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(TSCONFIG));
	});
	afterAll(() => {
		git.cleanup();
		rmSync(consumer, { recursive: true, force: true });
	});

	test('exports the parsers only, and Node.js reads the fixtures exactly as the source does', async () => {
		const options: LoadOptions = {
			claudeDir: resolve('test/fixtures/claude'),
			codexDir: resolve('test/fixtures/codex'),
			withGit: true,
			gitRoots: [git.root],
			authors: ['dev@acme.test']
		};
		const result = Bun.spawnSync(['node', 'run.mjs', JSON.stringify(options), SINCE], {
			cwd: consumer,
			stderr: 'pipe'
		});
		if (result.exitCode !== 0) throw new Error(`node failed:\n${result.stderr.toString()}`);
		const fromNode = JSON.parse(result.stdout.toString()) as { exports: string[]; files: number[]; rows: JsonDay[] };
		const fromSource = await loadSources(options, SINCE);

		expect(fromNode.exports).toEqual([
			'CLAUDE_PROJECTS',
			'CODEX_HOME',
			'loadClaude',
			'loadCodex',
			'loadGit',
			'loadSources'
		]);
		expect(fromNode.files).toEqual([fromSource.claudeFiles, fromSource.codexFiles, fromSource.repos]);
		expect(fromNode.rows.length).toBeGreaterThan(0);
		expect(fromNode.rows).toEqual(jsonRows(fromSource.days));
	});

	test('its declarations type-check in a strict NodeNext project', () => {
		const result = Bun.spawnSync([resolve('node_modules/.bin/tsc'), '-p', consumer], {
			stdout: 'pipe',
			stderr: 'pipe'
		});
		expect(result.stdout.toString() + result.stderr.toString()).toBe('');
		expect(result.exitCode).toBe(0);
	});
});
