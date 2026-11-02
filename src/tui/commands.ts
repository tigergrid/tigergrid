import type { Metric } from '../../types/grid';
import type { TuiAction, TuiCommand, TuiKey, TuiState } from '../../types/tui';
import { isMetric, isToolFilter, METRICS } from '../grid';
import { isCellStyle } from '../render/terminal';
import { isTerminalTheme } from '../render/theme';

// The TUI's input, kept pure so it can be tested without a terminal: `/` commands mirror the
// CLI flags, and single keys cover the common switches.

export const DEFAULT_SVG = 'out/tigergrid.svg';
export const DEFAULT_JSON = 'out/tigergrid.json';

export const COMMANDS: TuiCommand[] = [
	{ name: '/metric', usage: '<name>[,<name>…]', summary: 'prompts | sessions | tokens | commits | ai', flag: '-m' },
	{ name: '/tool', usage: '<claude|codex|all>', summary: 'which agents count', flag: '-t' },
	{ name: '/weeks', usage: '<n|fit>', summary: 'window size; fit fills the width', flag: '-w' },
	{ name: '/cells', usage: '<matrix|wide>', summary: 'how a day is drawn', flag: '--cells' },
	{ name: '/theme', usage: '<light|dark>', summary: 'colour ramp', flag: '--theme' },
	{ name: '/git', usage: '<on|off>', summary: 'scan git repos', flag: '--no-git' },
	{ name: '/svg', usage: '[file]', summary: `write an SVG card (default ${DEFAULT_SVG})`, flag: '--svg' },
	{ name: '/json', usage: '[file]', summary: `write per-day JSON (default ${DEFAULT_JSON})`, flag: '--json' },
	{ name: '/rescan', usage: '', summary: 'read every source again', flag: '' },
	{ name: '/help', usage: '', summary: 'keys and commands', flag: '-h' },
	{ name: '/quit', usage: '', summary: 'leave (also q or ctrl+c)', flag: '' }
];

export const KEYS: TuiKey[] = [
	{ keys: '← →', label: 'metric', summary: 'previous / next metric' },
	{ keys: 't', label: 'tool', summary: 'next tool' },
	{ keys: 'c', label: 'cells', summary: 'other cell style' },
	{ keys: 'l', label: 'theme', summary: 'light / dark' },
	{ keys: '+ -', label: 'weeks', summary: 'four weeks more / fewer' },
	{ keys: 'g', label: 'git', summary: 'git on / off' },
	{ keys: 's', label: 'svg', summary: `SVG to ${DEFAULT_SVG}` },
	{ keys: 'j', label: 'json', summary: `JSON to ${DEFAULT_JSON}` },
	{ keys: 'r', label: 'rescan', summary: 'read every source again' },
	{ keys: '/', label: 'command', summary: 'type a command' },
	{ keys: '?', label: 'help', summary: 'this screen' },
	{ keys: 'q', label: 'quit', summary: 'leave (also ctrl+c)' }
];

const TOOLS = ['all', 'claude', 'codex'] as const;

/**
 * Commands that start with what has been typed, while the command name is still being typed.
 *
 * @returns the matching commands; empty unless the line starts with `/` and has no space yet.
 * Called by: tui (App).
 * Calls: nothing.
 */
export const suggestionsFor = (line: string): TuiCommand[] =>
	line.startsWith('/') && !line.includes(' ') ? COMMANDS.filter((command) => command.name.startsWith(line)) : [];

/**
 * The usage line for the command being typed, once its name is complete.
 *
 * @returns e.g. `/tool <claude|codex|all>`, or null when the line names no command.
 * Called by: tui (App).
 * Calls: nothing.
 */
export function usageFor(line: string): string | null {
	const [name] = line.trim().split(/\s+/);
	const command = COMMANDS.find((candidate) => candidate.name === name);
	return command ? `${command.name} ${command.usage}`.trim() : null;
}

/**
 * Parse a submitted `/` line into an action, validating arguments the way the CLI validates
 * its flags.
 *
 * @returns the action, or an `error` action naming what was wrong.
 * Called by: tui (App), tests.
 * Calls: isMetric, isToolFilter, isCellStyle, isTerminalTheme.
 */
export function parseCommand(line: string): TuiAction {
	const [name = '', ...rest] = line.trim().split(/\s+/);
	const argument = rest.join(' ');
	const usage = usageFor(name);
	/** The error for a missing or wrong argument. Called by: parseCommand. Calls: nothing. */
	const wrong = (what: string): TuiAction => ({ kind: 'error', message: `${what}; usage: ${usage}` });

	switch (name) {
		case '/metric': {
			const metrics: Metric[] = [];
			for (const part of argument.split(',').map((each) => each.trim())) {
				if (!isMetric(part)) return wrong(part ? `unknown metric "${part}"` : 'name a metric');
				if (!metrics.includes(part)) metrics.push(part);
			}
			return { kind: 'set', changes: { metrics } };
		}
		case '/tool':
			return isToolFilter(argument)
				? { kind: 'set', changes: { tool: argument } }
				: wrong(`unknown tool "${argument}"`);
		case '/weeks': {
			if (argument === 'fit') return { kind: 'set', changes: { weeks: 'fit' } };
			const weeks = Number(argument);
			return Number.isInteger(weeks) && weeks >= 1
				? { kind: 'set', changes: { weeks } }
				: wrong('weeks must be a positive integer or fit');
		}
		case '/cells':
			return isCellStyle(argument)
				? { kind: 'set', changes: { cells: argument } }
				: wrong(`unknown cell style "${argument}"`);
		case '/theme':
			return isTerminalTheme(argument)
				? { kind: 'set', changes: { theme: argument } }
				: wrong(`unknown theme "${argument}"`);
		case '/git':
			if (argument === 'on' || argument === 'off') return { kind: 'set', changes: { withGit: argument === 'on' } };
			return wrong('say on or off');
		case '/svg':
			return { kind: 'svg', file: argument || DEFAULT_SVG };
		case '/json':
			return { kind: 'json', file: argument || DEFAULT_JSON };
		case '/rescan':
			return { kind: 'rescan' };
		case '/help':
			return { kind: 'help' };
		case '/quit':
			return { kind: 'quit' };
		default:
			return { kind: 'error', message: `unknown command: ${name || '(empty)'}` };
	}
}

/**
 * The metric `step` places away from the current one in METRICS order, wrapping around. A
 * combined graph steps from its first metric and becomes a single one.
 *
 * @returns the new metric list, one metric long.
 * Called by: hotkey.
 * Calls: nothing.
 */
function stepMetric(metrics: Metric[], step: number): Metric[] {
	const index = METRICS.indexOf(metrics[0] ?? 'prompts');
	return [METRICS[(index + step + METRICS.length) % METRICS.length]!];
}

/**
 * Map a key pressed with an empty prompt to an action. `shownWeeks` is how many weeks the
 * graph shows now, so `+` and `-` step from there when the window is `fit`.
 *
 * @returns the action, or null when the key does nothing.
 * Called by: tui (App), tests.
 * Calls: stepMetric.
 */
export function hotkey(
	input: string,
	arrow: 'left' | 'right' | null,
	state: TuiState,
	shownWeeks: number
): TuiAction | null {
	if (arrow) return { kind: 'set', changes: { metrics: stepMetric(state.metrics, arrow === 'right' ? 1 : -1) } };
	const current = state.weeks === 'fit' ? shownWeeks : state.weeks;
	switch (input) {
		case 't':
			return { kind: 'set', changes: { tool: TOOLS[(TOOLS.indexOf(state.tool) + 1) % TOOLS.length] } };
		case 'c':
			return { kind: 'set', changes: { cells: state.cells === 'matrix' ? 'wide' : 'matrix' } };
		case 'l':
			return { kind: 'set', changes: { theme: state.theme === 'dark' ? 'light' : 'dark' } };
		case '+':
		case '=':
			return { kind: 'set', changes: { weeks: current + 4 } };
		case '-':
			return { kind: 'set', changes: { weeks: Math.max(1, current - 4) } };
		case 'g':
			return { kind: 'set', changes: { withGit: !state.withGit } };
		case 's':
			return { kind: 'svg', file: DEFAULT_SVG };
		case 'j':
			return { kind: 'json', file: DEFAULT_JSON };
		case 'r':
			return { kind: 'rescan' };
		case '?':
			return { kind: 'help' };
		case 'q':
			return { kind: 'quit' };
		default:
			return null;
	}
}
