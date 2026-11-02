import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonDay } from '../types/cli';
import { buildGitFixture } from './helpers/git-fixture';

// End-to-end: run the real CLI against all fixtures. The window is 520 weeks so the
// fixture dates stay inside it for years; the old 2026-08-01 records are therefore included.
const git = buildGitFixture();
const out = mkdtempSync(join(tmpdir(), 'tigergrid-out-'));
afterAll(() => {
	git.cleanup();
	rmSync(out, { recursive: true, force: true });
});

const FIXTURE_ARGS = [
	'-w',
	'520',
	'--claude-dir',
	'test/fixtures/claude',
	'--codex-dir',
	'test/fixtures/codex',
	'--git-root',
	git.root,
	'--author',
	'dev@acme.test'
];

/** Run the CLI with plain output; returns exit code, stdout and stderr. */
function cli(...args: string[]) {
	const command = process.env.TIGERGRID_TEST_NODE === '1' ? ['node', 'dist/node/cli.js'] : ['bun', 'src/cli.ts'];
	const result = Bun.spawnSync([...command, ...args], { env: { ...process.env, NO_COLOR: '1' } });
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe('--json', () => {
	const { code, stdout } = cli('--json', ...FIXTURE_ARGS);
	// Our own --json output, whose shape types/cli.ts defines.
	const rows = JSON.parse(stdout) as JsonDay[];
	const byDate = Object.fromEntries(rows.map((result) => [result.date, result]));

	test('exits cleanly with one row per active day, sorted by date, and no footer', () => {
		expect(code).toBe(0);
		expect(rows.map((result) => result.date)).toEqual([
			'2026-08-01',
			'2026-09-08',
			'2026-09-09',
			'2026-09-10',
			'2026-09-11',
			'2026-09-12'
		]);
	});

	test('merges all three sources per day', () => {
		expect(byDate['2026-09-09']).toEqual({
			date: '2026-09-09',
			sessions: { claude: 2, codex: 0 },
			prompts: { claude: 2, codex: 0 },
			tokens: { claude: 750, codex: 0 },
			commits: 1,
			aiCommits: 1,
			projects: { 'acme/api': 1, 'acme/web': 1 }
		});
		expect(byDate['2026-09-12']).toMatchObject({
			prompts: { claude: 0, codex: 1 },
			tokens: { claude: 0, codex: 1200 },
			commits: 1,
			aiCommits: 1
		});
	});
});

describe('terminal output', () => {
	const { code, stdout } = cli('-m', 'prompts', ...FIXTURE_ARGS);

	test('prints the headline and the per-source summary', () => {
		expect(code).toBe(0);
		expect(stdout).toContain('8 prompts in the last 520 weeks · Claude Code + Codex');
		expect(stdout).toMatch(/Claude Code\s+2 sessions · 5 prompts · 2,150 tokens/);
		expect(stdout).toMatch(/Codex\s+2 sessions · 3 prompts · 2,360 tokens/);
		expect(stdout).toMatch(/git\s+5 commits · 3 AI-assisted \(60%\)/);
		expect(stdout).toMatch(/top projects\s+acme\/api 6 · acme\/web 2/);
		expect(stdout).toContain('scanned 3 Claude + 4 Codex transcripts, 3 repos');
	});

	test('--tool claude hides the Codex line', () => {
		const result = cli('-t', 'claude', ...FIXTURE_ARGS);
		expect(result.stdout).toContain('5 prompts in the last 520 weeks · Claude Code');
		expect(result.stdout).not.toMatch(/Codex\s+\d+ sessions/);
	});
});

describe('--svg', () => {
	test('writes a git-titled SVG and creates missing parent directories', () => {
		const path = join(out, 'nested', 'ai.svg');
		const result = cli('-m', 'ai', '--svg', path, ...FIXTURE_ARGS);
		expect(result.code).toBe(0);
		expect(existsSync(path)).toBe(true);
		const svg = readFileSync(path, 'utf8');
		expect(svg).toContain('Git activity');
		expect(svg).toContain('ui-monospace'); // matrix by default, like the terminal
		expect(svg).toContain('AI-assisted commits');
		expect(svg).not.toContain('href=');
		expect(svg).not.toContain('Made with');
	});
});

describe('argument errors', () => {
	test('--version names the package version; from source the commit is "dev"', () => {
		const result = cli('--version');
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(/^tigergrid \d+\.\d+\.\d+ \(dev\)$/);
	});

	test('--help prints usage', () => {
		const result = cli('--help');
		expect(result.code).toBe(0);
		expect(result.stdout).toStartWith('TigerGrid — a contribution graph');
	});

	test('an unknown metric exits 1 with a message', () => {
		const result = cli('-m', 'vibes');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('tigergrid: unknown metric "vibes"');
	});

	test('an unknown cell style or theme exits 1', () => {
		expect(cli('--cells', 'round').stderr).toContain('tigergrid: unknown cell style "round"');
		expect(cli('--theme', 'solarized').stderr).toContain('tigergrid: unknown theme "solarized"');
	});

	test('both cell styles render', () => {
		for (const style of ['wide', 'matrix']) {
			const result = cli('--cells', style, '--theme', 'light', ...FIXTURE_ARGS);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('Mon ');
			expect(result.stdout).not.toContain('Less');
		}
	});

	test('matrix is the default: two columns per week', () => {
		const grid = cli('-w', '8', ...FIXTURE_ARGS.slice(2)).stdout.split('\n');
		expect(grid.find((line) => line.startsWith('Mon '))).toHaveLength(4 + 8 * 2);
	});

	test('a comma list of metrics draws one combined graph: a bar per metric and a gap per week', () => {
		const result = cli('-m', 'prompts,sessions,ai', '-w', '8', ...FIXTURE_ARGS.slice(2));
		expect(result.code).toBe(0);
		const lines = result.stdout.split('\n');
		expect(lines.find((line) => line.startsWith('Mon '))).toHaveLength(4 + 8 * 4);
		expect(result.stdout).toContain('bars, left to right: prompts · agent sessions · AI-assisted commits');
		expect(result.stdout).toContain('Claude Code + Codex + git');
		for (const metric of ['prompts', 'sessions', 'ai']) {
			expect(lines.some((line) => line.trimStart().startsWith(`${metric} `))).toBe(true);
		}
	});

	test('a combined graph rejects unknown metrics', () => {
		expect(cli('-m', 'prompts,vibes').stderr).toContain('tigergrid: unknown metric "vibes"');
	});

	test('--svg with several metrics writes a combined card', () => {
		const path = join(out, 'combined.svg');
		expect(cli('-m', 'prompts,ai', '--svg', path, ...FIXTURE_ARGS).code).toBe(0);
		const svg = readFileSync(path, 'utf8');
		expect(svg).toContain('Agent activity · Claude Code + Codex + git');
		expect(svg).toContain('<title>2026-09-08: 2 prompts · 1 AI-assisted commits</title>');
		expect(svg).not.toContain('Less');
	});

	test('errors go to stderr alone, the usage text to stdout', () => {
		const result = cli('-m', 'vibes');
		expect(result.stderr.trim()).toBe('tigergrid: unknown metric "vibes"');
		expect(result.stdout).toContain('Usage: tigergrid [options]');
	});

	test('--interactive without a terminal exits 1 instead of drawing into a pipe', () => {
		const result = cli('-i', ...FIXTURE_ARGS);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('tigergrid: --interactive needs a terminal');
	});

	test('an unknown tool exits 1', () => {
		expect(cli('-t', 'cursor').code).toBe(1);
	});

	test('--weeks must be a positive integer', () => {
		expect(cli('-w', '0').stderr).toContain('--weeks must be a positive integer');
		expect(cli('-w', 'two').code).toBe(1);
	});
});
