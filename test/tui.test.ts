// End-to-end: run `tigergrid -i` against the fixtures on a real pseudo-terminal (Bun.Terminal)
// and read what a user would see through a headless xterm.js. The pty makes raw mode, SIGWINCH
// and Ctrl+C behave as in a real terminal; the emulator lets checks read rendered text, because
// Ink's incremental rendering only rewrites the cells that changed.
//
// Runs from source; with TIGERGRID_TEST_NODE=1, the Node build; with TIGERGRID_TUI_BINARY, that
// compiled binary (CI's binaries job sets it on each platform).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal as Screen } from '@xterm/headless';
import type { JsonDay } from '../types/cli';
import { buildGitFixture } from './helpers/git-fixture';

const COLS = 100;
const ROWS = 32;
/** The TUI as the other end-to-end tests run it: from source, the Node build, or a compiled binary. */
function command(): string[] {
	if (process.env.TIGERGRID_TUI_BINARY) return [process.env.TIGERGRID_TUI_BINARY];
	return process.env.TIGERGRID_TEST_NODE === '1' ? ['node', 'dist/node/cli.js'] : ['bun', 'src/cli.ts'];
}
const COMMAND = command();

// The same fixtures and 520-week window as test/cli.test.ts; --theme skips the terminal
// colour question, which the headless emulator doesn't answer.
const git = buildGitFixture();
const out = mkdtempSync(join(tmpdir(), 'tigergrid-tui-'));
afterAll(() => {
	git.cleanup();
	rmSync(out, { recursive: true, force: true });
});
const ARGS = [
	'-i',
	'--theme',
	'dark',
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

// c_lflag bits; the values differ between Linux and macOS.
const LFLAG = process.platform === 'darwin' ? { echo: 0x8, icanon: 0x100 } : { echo: 0o10, icanon: 0o2 };

// Above waitFor's 5 s, so a stuck step fails with the screen it was looking at rather than
// a bare "test timed out".
setDefaultTimeout(15_000);

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';

/**
 * One run of the TUI on a fresh pty, its output mirrored into a headless xterm.
 */
class Session {
	readonly started = performance.now();
	readonly screen = new Screen({ cols: COLS, rows: ROWS, allowProposedApi: true });
	readonly terminal: Bun.Terminal;
	readonly proc: Bun.Subprocess;
	private chunks: Uint8Array[] = [];

	/**
	 * Spawn the binary with the pty as its controlling terminal. CI is removed from the
	 * environment because Ink renders non-interactively when it sees it.
	 *
	 * Called by: the describe blocks.
	 * Calls: Bun.Terminal, Bun.spawn.
	 */
	constructor() {
		this.terminal = new Bun.Terminal({
			cols: COLS,
			rows: ROWS,
			data: (_, data) => {
				this.chunks.push(data);
				this.screen.write(data);
			}
		});
		const { CI: _, ...env } = process.env;
		this.proc = Bun.spawn([...COMMAND, ...ARGS], { terminal: this.terminal, env: { ...env, COLORTERM: 'truecolor' } });
	}

	/**
	 * Everything the binary wrote so far, escape codes included.
	 *
	 * @returns the raw output as a latin1 string, so byte sequences compare one-to-one.
	 * Called by: tests.
	 * Calls: Buffer.concat.
	 */
	raw(): string {
		return Buffer.concat(this.chunks).toString('latin1');
	}

	/**
	 * The visible screen of whichever buffer (normal or alternate) is active.
	 *
	 * @returns the rows joined with newlines, trailing spaces trimmed.
	 * Called by: waitFor, tests.
	 * Calls: xterm buffer API.
	 */
	text(): string {
		const buffer = this.screen.buffer.active;
		const rows: string[] = [];
		for (let row = 0; row < this.screen.rows; row++) {
			rows.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
		}
		return rows.join('\n');
	}

	/**
	 * Type into the terminal. One call is one write, which Ink reads as one chunk: several
	 * characters in one call arrive as a paste.
	 *
	 * Called by: tests.
	 * Calls: Bun.Terminal.write, Bun.sleep.
	 */
	async send(data: string) {
		this.terminal.write(data);
		await Bun.sleep(50);
	}

	/**
	 * Resize the pty and the emulator, then send SIGWINCH ourselves: Bun.spawn doesn't make
	 * the pty the child's controlling terminal (no setsid/TIOCSCTTY as of Bun 1.4.4), so the
	 * kernel has no foreground process group to signal. The child still reads the new size
	 * from the pty, exactly as it would in a real terminal.
	 *
	 * Called by: tests.
	 * Calls: xterm resize, Bun.Terminal.resize, Subprocess.kill.
	 */
	resize(cols: number, rows: number) {
		this.screen.resize(cols, rows);
		this.terminal.resize(cols, rows);
		this.proc.kill('SIGWINCH');
	}

	/**
	 * Poll the screen until it shows `needle`.
	 *
	 * @returns milliseconds since spawn when it appeared.
	 * @throws with the current screen when it doesn't appear in time.
	 * Called by: tests.
	 * Calls: text, Bun.sleep.
	 */
	async waitFor(needle: string, timeout = 5000): Promise<number> {
		const deadline = performance.now() + timeout;
		while (performance.now() < deadline) {
			if (this.text().includes(needle)) return performance.now() - this.started;
			await Bun.sleep(20);
		}
		throw new Error(`timed out waiting for ${JSON.stringify(needle)}; screen:\n${this.text()}`);
	}

	/**
	 * Whether the pty is back in cooked mode (echo and line editing on), as a shell expects.
	 *
	 * @returns true when both ECHO and ICANON are set.
	 * Called by: tests.
	 * Calls: Bun.Terminal.localFlags.
	 */
	cooked(): boolean {
		const flags = this.terminal.localFlags;
		return (flags & LFLAG.echo) !== 0 && (flags & LFLAG.icanon) !== 0;
	}

	/**
	 * Wait for the process to exit and the emulator to catch up with its last output.
	 *
	 * @returns the exit code, or null when a signal ended it.
	 * Called by: tests.
	 * Calls: Subprocess.exited, Bun.sleep.
	 */
	async exited(): Promise<number | null> {
		await this.proc.exited;
		await Bun.sleep(100);
		return this.proc.exitCode;
	}

	/**
	 * Kill the process if it's still running and release the pty.
	 *
	 * Called by: afterAll hooks.
	 * Calls: Subprocess.kill, Bun.Terminal.close, xterm dispose.
	 */
	close() {
		if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill();
		this.terminal.close();
		this.screen.dispose();
	}
}

/**
 * The headline row of the graph panel, e.g. `8 prompts in the last 520 weeks · …`.
 *
 * @returns the first screen line containing "in the last", or ''.
 * Called by: tests.
 * Calls: Session.text.
 */
const headline = (session: Session) =>
	session
		.text()
		.split('\n')
		.find((line) => line.includes('in the last')) ?? '';

describe(`tigergrid -i (${COMMAND.join(' ')})`, () => {
	describe('a full session', () => {
		let session: Session;
		beforeAll(() => {
			session = new Session();
		});
		afterAll(() => session.close());

		test('first frame: the fixtures load and the graph draws', async () => {
			const elapsed = await session.waitFor('8 prompts in the last 520 weeks');
			console.log(`first frame with data after ${elapsed.toFixed(0)} ms`);
			expect(session.text()).toContain('tigergrid');
			// 100 columns minus border and padding fit 46 two-column weeks after the weekday labels.
			expect(session.text()).toContain('the graph shows the last 46 of 520 weeks');
		});

		test('fullscreen and raw mode while running', () => {
			expect(session.raw()).toContain(ENTER_ALT);
			expect(session.screen.buffer.active.type).toBe('alternate');
			expect(session.cooked()).toBe(false);
		});

		test('the graph and stats are the same as the CLI prints', () => {
			const text = session.text();
			expect(text).toContain('Mon ');
			expect(text).toContain('active days');
			expect(text).toContain('5 commits · 3 AI-assisted (60%)');
			expect(text).toContain('top projects');
			expect(text).toContain('acme/api');
			expect(session.raw()).toContain('38;2;'); // 24-bit colour from the PALETTES hex values
		});

		test('→ steps to the next metric', async () => {
			await session.send('\x1b[C');
			await session.waitFor('agent sessions in the last 520 weeks');
		});

		test('t switches the tool', async () => {
			await session.send('t');
			await session.waitFor('· claude ·');
			expect(headline(session)).toMatch(/weeks · Claude Code(?! \+)/);
		});

		test('/ lists commands, Tab completes, Enter runs', async () => {
			await session.send('/');
			await session.waitFor('› /');
			expect(session.text()).toContain('/metric <name>');
			await session.send('me');
			await session.send('\t');
			await session.waitFor('› /metric ');
			await session.send('prompts,sessions,ai');
			await session.send('\r');
			await session.waitFor('AI-assisted commits in the last 520 weeks');
			expect(headline(session)).toContain('· Claude Code + git');
		});

		test('/svg writes the card for what is shown', async () => {
			const path = join(out, 'tui.svg');
			await session.send(`/svg ${path}`);
			await session.send('\r');
			await session.waitFor(`wrote ${path}`);
			const svg = readFileSync(path, 'utf8');
			expect(svg).toContain('Agent activity · Claude Code + git');
		});

		test('/json writes the per-day rows', async () => {
			const path = join(out, 'tui.json');
			await session.send(`/json ${path}`);
			await session.send('\r');
			await session.waitFor(`wrote ${path}`);
			// Our own --json shape, which types/cli.ts defines.
			const rows = JSON.parse(readFileSync(path, 'utf8')) as JsonDay[];
			expect(rows.map((row) => row.date)).toContain('2026-09-08');
		});

		test('resize re-fits the graph', async () => {
			session.resize(72, 28);
			// Three bars and a gap per week: (72 - 4 - 4) / 4.
			await session.waitFor('the graph shows the last 16 of 520 weeks');
		});

		test('a pasted newline does not submit', async () => {
			await session.send('/no\rpe');
			await session.waitFor('› /nope');
			expect(session.text()).not.toContain('unknown command');
			await session.send('\r');
			await session.waitFor('unknown command: /nope');
		});

		test('? shows the keys and commands, ? again closes them', async () => {
			await session.send('?');
			await session.waitFor('esc or ? closes this');
			await session.waitFor('/quit');
			expect(session.text()).toMatch(/\/svg \[file\] +--svg /);
			await session.send('?');
			await session.waitFor('the graph shows the last 16 of 520 weeks');
		});

		test('ctrl+c exits 0 and restores the terminal', async () => {
			await session.send('\x03');
			expect(await session.exited()).toBe(0);
			const raw = session.raw();
			expect(raw.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(raw.lastIndexOf(ENTER_ALT));
			expect(raw.lastIndexOf('\x1b[?25h')).toBeGreaterThan(raw.lastIndexOf('\x1b[?25l')); // cursor shown
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.cooked()).toBe(true);
		});
	});

	describe('other ways out', () => {
		let session: Session;
		afterAll(() => session.close());

		test('q exits 0 and restores the terminal', async () => {
			session = new Session();
			await session.waitFor('in the last 520 weeks');
			await session.send('q');
			expect(await session.exited()).toBe(0);
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.cooked()).toBe(true);
		});

		test('/quit exits 0', async () => {
			session.close();
			session = new Session();
			await session.waitFor('in the last 520 weeks');
			await session.send('/quit');
			await session.send('\r');
			expect(await session.exited()).toBe(0);
		});

		test('SIGTERM restores the terminal', async () => {
			session.close();
			session = new Session();
			await session.waitFor('in the last 520 weeks');
			session.proc.kill('SIGTERM');
			await session.exited();
			expect(session.proc.signalCode).toBe('SIGTERM');
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.cooked()).toBe(true);
		});
	});
});
