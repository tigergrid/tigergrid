// End-to-end: run the compiled spike on a real pseudo-terminal (Bun.Terminal) and read what a
// user would see through a headless xterm.js. The pty makes raw mode, SIGWINCH and Ctrl+C
// behave as in a real terminal; the emulator lets checks read rendered text, because Ink's
// incremental rendering only rewrites the cells that changed.
//
// Runs the binary for this machine (dist/spike-<os>-<arch>), or TUI_BINARY if set; skips
// when neither exists, so `bun test` at the repo root passes before `bun build.ts` has run.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal as Screen } from '@xterm/headless';

const COLS = 100;
const ROWS = 30;
const BINARY =
	process.env.TUI_BINARY ?? join(import.meta.dir, '..', 'dist', `spike-${process.platform}-${process.arch}`);

// c_lflag bits; the values differ between Linux and macOS.
const LFLAG = process.platform === 'darwin' ? { echo: 0x8, icanon: 0x100 } : { echo: 0o10, icanon: 0o2 };

// Above waitFor's 5 s, so a stuck step fails with the screen it was looking at rather than
// a bare "test timed out".
setDefaultTimeout(15_000);

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';

/**
 * One run of the binary on a fresh pty, its output mirrored into a headless xterm.
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
		this.proc = Bun.spawn([BINARY], { terminal: this.terminal, env: { ...env, COLORTERM: 'truecolor' } });
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

describe.skipIf(!existsSync(BINARY))(`spike TUI (${BINARY})`, () => {
	describe('a full session', () => {
		let session: Session;
		beforeAll(() => {
			session = new Session();
		});
		afterAll(() => session.close());

		test('first frame', async () => {
			await session.waitFor('tigergrid · ink spike');
			const elapsed = await session.waitFor('/quit');
			console.log(`first frame after ${elapsed.toFixed(0)} ms`);
			expect(session.text()).toContain(`${COLS}x${ROWS}`);
		});

		test('fullscreen and raw mode while running', () => {
			expect(session.raw()).toContain(ENTER_ALT);
			expect(session.screen.buffer.active.type).toBe('alternate');
			expect(session.cooked()).toBe(false);
		});

		test('/ lists commands, Tab completes, Enter runs', async () => {
			await session.send('/');
			await session.waitFor('› /');
			// once in the help view, once in the suggestion list
			expect(session.text().split('/scan').length - 1).toBeGreaterThanOrEqual(2);
			await session.send('ta');
			await session.send('\t');
			await session.waitFor('› /table');
			await session.send('\r');
			await session.waitFor('GRID-41');
			expect(session.text()).toContain('ran /table');
		});

		test('resize re-lays out', async () => {
			session.resize(72, 20);
			await session.waitFor('72x20');
			expect(session.text()).toContain('…'); // the table subject truncates
		});

		test('grid fits the new width in truecolor', async () => {
			await session.send('/grid');
			await session.send('\r');
			await session.waitFor('weeks · prompts');
			expect(session.text()).toContain('32 weeks'); // (72 - 4 border - 4) / 2
			expect(session.raw()).toContain('38;2;'); // 24-bit SGR from the PALETTES hex values
		});

		test('a pasted newline does not submit', async () => {
			await session.send('/no\rpe');
			await session.waitFor('› /nope');
			expect(session.text()).not.toContain('unknown command');
			await session.send('\r');
			await session.waitFor('unknown command: /nope');
		});

		test('timer-driven redraws (spinner + progress bar)', async () => {
			await session.send('/scan');
			await session.send('\r');
			await session.waitFor('scanning transcripts');
			await session.waitFor('scan done');
		});

		test('ctrl+c exits 0 and restores the terminal', async () => {
			await session.send('\x03');
			expect(await session.exited()).toBe(0);
			const raw = session.raw();
			expect(raw.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(raw.lastIndexOf(ENTER_ALT));
			expect(raw.lastIndexOf('\x1b[?25h')).toBeGreaterThan(raw.lastIndexOf('\x1b[?25l')); // cursor shown
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.text()).toContain('exited cleanly');
			expect(session.cooked()).toBe(true);
		});
	});

	describe('other ways out', () => {
		let session: Session;
		afterAll(() => session.close());

		test('/quit exits 0 and restores the terminal', async () => {
			session = new Session();
			await session.waitFor('/quit');
			await session.send('/quit');
			await session.send('\r');
			expect(await session.exited()).toBe(0);
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.cooked()).toBe(true);
		});

		test('SIGTERM restores the terminal', async () => {
			session.close();
			session = new Session();
			await session.waitFor('/quit');
			session.proc.kill('SIGTERM');
			await session.exited();
			expect(session.proc.signalCode).toBe('SIGTERM');
			expect(session.screen.buffer.active.type).toBe('normal');
			expect(session.cooked()).toBe(true);
		});
	});
});
