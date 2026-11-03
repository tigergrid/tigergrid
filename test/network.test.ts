import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitFixture } from './helpers/git-fixture';

// Grid promises that nothing leaves the machine unless the user signs in. Bun ignores
// patched or redirected builtins (`node:net`, `node:https`, child_process), so the check
// runs one level down: every CLI mode runs under strace, child processes included, and
// any IPv4/IPv6 connect or sendto fails the test, DNS lookups among them. HOME points at an
// empty directory, so there are no credentials to sign in with. Linux only; CI installs
// strace, so a missing strace fails there instead of skipping.
const STRACE = Bun.which('strace');
const runs = process.platform === 'linux' && (STRACE !== null || process.env.CI === 'true');

const git = buildGitFixture();
const scratch = mkdtempSync(join(tmpdir(), 'tigergrid-network-'));
afterAll(() => {
	git.cleanup();
	rmSync(scratch, { recursive: true, force: true });
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

/**
 * Run a command under strace and collect the IP socket calls it and its children made.
 *
 * @returns the exit code and the traced connect/sendto lines with an AF_INET or AF_INET6 address.
 * Called by: the tests below.
 * Calls: Bun.spawnSync (strace), readFileSync.
 */
function traced(name: string, command: string[]) {
	const log = join(scratch, `${name}.strace`);
	const home = join(scratch, 'home');
	const result = Bun.spawnSync(
		['strace', '-f', '-qq', '-e', 'trace=connect,sendto,sendmsg', '-e', 'signal=none', '-o', log, ...command],
		{ env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1' } }
	);
	const calls = readFileSync(log, 'utf8')
		.split('\n')
		.filter((line) => line.includes('sa_family=AF_INET'));
	return { code: result.exitCode, calls };
}

describe.if(runs)('no network without a login', () => {
	test('the trace sees a connect when one happens', () => {
		const probe = traced('probe', ['bun', '-e', "await fetch('http://127.0.0.1:9').catch(() => {})"]);
		expect(probe.calls.length).toBeGreaterThan(0);
	});

	const modes: Record<string, string[]> = {
		help: ['--help'],
		version: ['--version'],
		json: ['--json', ...FIXTURE_ARGS],
		svgMatrix: ['-m', 'ai', '--svg', join(scratch, 'matrix.svg'), ...FIXTURE_ARGS],
		svgWide: ['-m', 'tokens', '--cells', 'wide', '--svg', join(scratch, 'wide.svg'), ...FIXTURE_ARGS],
		svgCombined: ['-m', 'prompts,sessions,ai', '--svg', join(scratch, 'combined.svg'), ...FIXTURE_ARGS],
		terminalCombined: ['-m', 'prompts,sessions,ai', ...FIXTURE_ARGS]
	};
	for (const metric of ['prompts', 'sessions', 'tokens', 'commits', 'ai']) {
		modes[`terminal-${metric}`] = ['-m', metric, ...FIXTURE_ARGS];
	}
	for (const tool of ['claude', 'codex', 'all']) {
		modes[`terminal-${tool}`] = ['-t', tool, ...FIXTURE_ARGS];
	}

	for (const [name, args] of Object.entries(modes)) {
		test(`${name} makes no IP connections`, () => {
			const run = traced(name, ['bun', 'src/cli.ts', ...args]);
			expect(run.code).toBe(0);
			expect(run.calls).toEqual([]);
		});
	}
});
