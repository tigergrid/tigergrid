import { Spinner } from '@inkjs/ui';
import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import Gradient from 'ink-gradient';
import { useEffect, useState } from 'react';
import type { Loaded, LoadOptions, View } from '../../types/cli';
import type { TuiAction, TuiState } from '../../types/tui';
import { dayKey } from '../days';
import { gridStart, PALETTES } from '../grid';
import { loadSources } from '../load';
import { barsWidth, cellWidth, renderBars, renderGrid } from '../render/terminal';
import { buildView, scopeOf, summaryLines, totalsLine, writeJson, writeSvg } from '../report';
import { COMMANDS, hotkey, KEYS, parseCommand, suggestionsFor, usageFor } from './commands';

// The interactive TUI (`tigergrid -i`): the same graph, stats and exports as the CLI, drawn
// with the CLI's own renderers inside an Ink fullscreen app. Keys switch metric, tool, cells,
// theme, window and git; `/` commands mirror the CLI flags.

const BRAND = ['#8fd12a', '#3667e6', '#d63d7c'];
/** The widest window `fit` uses, as in the CLI; also the least the TUI scans. */
const MAX_FIT = 53;

/** What a scan covers; a new object starts a new scan. */
interface Scan {
	weeks: number;
	withGit: boolean;
}

/** A line in the status bar: the outcome of the last command. */
interface Message {
	text: string;
	error: boolean;
}

/**
 * Which arrow key, if any, a key event is.
 *
 * @returns 'left', 'right' or null.
 * Called by: App's input handler.
 * Calls: nothing.
 */
function arrowOf(key: { leftArrow: boolean; rightArrow: boolean }): 'left' | 'right' | null {
	if (key.leftArrow) return 'left';
	if (key.rightArrow) return 'right';
	return null;
}

/**
 * Describe an error for the status bar.
 *
 * @returns the error's message.
 * Called by: App.
 * Calls: nothing.
 */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The graph panel: headline, the terminal graph (one metric's grid or the combined bars),
 * then the stats block. The window counts `windowWeeks`; the graph draws the last `shown`
 * of them when the full window doesn't fit the width.
 *
 * @returns the panel's lines; each truncates rather than wraps.
 * Called by: App.
 * Calls: totalsLine, scopeOf, buildView, renderBars, renderGrid, summaryLines.
 */
function GraphPanel(props: { loaded: Loaded; view: View; state: TuiState; windowWeeks: number; shown: number }) {
	const { loaded, view, state, windowWeeks, shown } = props;
	const { scope } = scopeOf(state.metrics, state.tool);
	const drawn = shown === windowWeeks ? view : buildView(loaded.days, state.metrics, state.tool, shown);
	const [first] = drawn.grids;
	if (!first) return null;
	const graph =
		drawn.grids.length > 1
			? renderBars(drawn.grids, { theme: state.theme })
			: renderGrid(first[1], first[0], { cells: state.cells, theme: state.theme });
	// flexShrink 0: when the panel is taller than the screen, the frame clips it; shrinking
	// would squash lines to zero height and draw them over each other.
	return (
		<Box flexDirection="column" flexShrink={0}>
			<Text wrap="truncate-end">
				<Text bold>{totalsLine(view)}</Text>
				<Text dimColor>
					{' '}
					in the last {windowWeeks} weeks · {scope}
				</Text>
			</Text>
			<Text dimColor wrap="truncate-end">
				{shown < windowWeeks ? `the graph shows the last ${shown} of ${windowWeeks} weeks` : ' '}
			</Text>
			{graph.split('\n').map((line, index) => (
				<Text key={index} wrap="truncate-end">
					{line || ' '}
				</Text>
			))}
			<Text> </Text>
			{summaryLines(loaded.days, view, state.tool, state.withGit).map((line, index) =>
				line ? (
					<Text key={index} wrap="truncate-end">
						<Text dimColor>{line.label.padEnd(16)}</Text>
						{line.text}
					</Text>
				) : (
					<Text key={index}> </Text>
				)
			)}
		</Box>
	);
}

/**
 * The help panel: every key, two to a row so it fits small terminals, then every `/`
 * command with the CLI flag it mirrors.
 *
 * @returns the keys grid and the command list.
 * Called by: App.
 * Calls: nothing.
 */
function HelpPanel() {
	const pairs = KEYS.filter((_, index) => index % 2 === 0).map((key, index) => [key, KEYS[index * 2 + 1]] as const);
	return (
		<Box flexDirection="column" flexShrink={0}>
			<Text wrap="truncate-end">
				<Text bold>keys</Text>
				<Text dimColor> · esc or ? closes this</Text>
			</Text>
			{pairs.map(([left, right]) => (
				<Box key={left.keys}>
					{[left, right].map(
						(key) =>
							key && (
								<Box key={key.keys} width={34} flexShrink={1}>
									<Text wrap="truncate-end">
										<Text color="cyan">{key.keys.padEnd(5)}</Text>
										{key.summary}
									</Text>
								</Box>
							)
					)}
				</Box>
			))}
			<Text> </Text>
			<Text wrap="truncate-end">
				<Text bold>commands</Text>
				<Text dimColor> · with the CLI flag each mirrors</Text>
			</Text>
			{COMMANDS.map((command) => (
				<Text key={command.name} wrap="truncate-end">
					<Text color="cyan">{`${command.name} ${command.usage}`.padEnd(26)}</Text>
					<Text dimColor>{command.flag.padEnd(10)}</Text>
					{command.summary}
				</Text>
			))}
		</Box>
	);
}

/**
 * The fullscreen app: a header with the current settings, the graph (or help) panel, the
 * command prompt with its suggestions, a status line and the key bar. Scans run on start, on
 * `r`, when git is switched, and when a window wider than the last scan is asked for.
 *
 * @returns the whole screen, sized to the terminal.
 * Called by: runTui.
 * Calls: loadSources, buildView, hotkey, parseCommand, suggestionsFor, usageFor, writeSvg, writeJson, the panels.
 */
function App({ initial, sources }: { initial: TuiState; sources: LoadOptions }) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [state, setState] = useState<TuiState>(initial);
	const [scan, setScan] = useState<Scan>({
		weeks: Math.max(MAX_FIT, initial.weeks === 'fit' ? 0 : initial.weeks),
		withGit: initial.withGit
	});
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [scanning, setScanning] = useState(true);
	const [message, setMessage] = useState<Message | null>(null);
	const [help, setHelp] = useState(false);
	const [line, setLine] = useState('');
	const [selected, setSelected] = useState(0);

	useEffect(() => {
		let current = true;
		setScanning(true);
		loadSources({ ...sources, withGit: scan.withGit }, dayKey(gridStart(scan.weeks)))
			.then((result) => {
				if (current) setLoaded(result);
			})
			.catch((error: unknown) => {
				if (current) setMessage({ text: `scan failed: ${errorText(error)}`, error: true });
			})
			.finally(() => {
				if (current) setScanning(false);
			});
		return () => {
			current = false;
		};
	}, [scan, sources]);

	// Border and padding take four columns; the weekday labels take four more.
	const inner = Math.max(20, columns - 4);
	const weekWidth = state.metrics.length > 1 ? barsWidth(state.metrics.length) : cellWidth(state.cells);
	const fit = Math.max(4, Math.min(MAX_FIT, Math.floor((inner - 4) / weekWidth)));
	const windowWeeks = state.weeks === 'fit' ? fit : state.weeks;
	const shown = Math.min(windowWeeks, fit);
	const view = loaded ? buildView(loaded.days, state.metrics, state.tool, windowWeeks) : null;
	const suggestions = suggestionsFor(line);
	const usage = suggestions.length ? null : usageFor(line);

	/**
	 * Carry out a hotkey's or command's action.
	 *
	 * @returns nothing; updates state, starts a scan or an export, or exits.
	 * Called by: App's input handler.
	 * Calls: setScan, writeSvg, writeJson, exit.
	 */
	function apply(action: TuiAction) {
		switch (action.kind) {
			case 'set': {
				const next = { ...state, ...action.changes };
				setState(next);
				setMessage(null);
				const needed = next.weeks === 'fit' ? MAX_FIT : next.weeks;
				if (needed > scan.weeks || next.withGit !== scan.withGit) {
					setScan({ weeks: Math.max(scan.weeks, needed), withGit: next.withGit });
				}
				return;
			}
			case 'svg':
			case 'json': {
				if (!loaded || !view) return setMessage({ text: 'still scanning; try again in a moment', error: true });
				const written =
					action.kind === 'svg'
						? writeSvg(action.file, view, state.tool, state.cells)
						: writeJson(action.file, loaded.days);
				written
					.then((path) => setMessage({ text: `wrote ${path}`, error: false }))
					.catch((error: unknown) => setMessage({ text: `could not write: ${errorText(error)}`, error: true }));
				return;
			}
			case 'rescan':
				setMessage(null);
				return setScan({ ...scan });
			case 'help':
				return setHelp(!help);
			case 'quit':
				return exit();
			case 'error':
				return setMessage({ text: action.message, error: true });
		}
	}

	/**
	 * Run the prompt's line as a `/` command and clear the prompt.
	 *
	 * @returns nothing.
	 * Called by: App's input handler.
	 * Calls: apply, parseCommand.
	 */
	function submit(text: string) {
		setLine('');
		setSelected(0);
		apply(parseCommand(text));
	}

	useInput((input, key) => {
		if (line) {
			const suggestion = suggestions[selected];
			if (key.return) {
				// A half-typed name runs the highlighted command, or completes it when it needs an argument.
				if (suggestion && line !== suggestion.name) {
					if (suggestion.usage.startsWith('<')) return setLine(`${suggestion.name} `);
					return submit(suggestion.name);
				}
				return submit(line);
			}
			if (key.tab && suggestion) return setLine(`${suggestion.name}${suggestion.usage ? ' ' : ''}`);
			if (key.upArrow) return setSelected((current) => Math.max(0, current - 1));
			if (key.downArrow) return setSelected((current) => Math.min(suggestions.length - 1, current + 1));
			if (key.escape) return setLine('');
			if (key.backspace || key.delete) {
				setLine((current) => current.slice(0, -1));
				return setSelected(0);
			}
		}
		// A paste arrives as one chunk with key.return false, newline included; strip control
		// characters so a pasted line never smuggles a \r into the prompt.
		const printable = input.replace(/[\x00-\x1f\x7f]/g, ''); // eslint-disable-line no-control-regex
		if (line) {
			if (printable && !key.ctrl && !key.meta) {
				setLine((current) => current + printable);
				setSelected(0);
			}
			return;
		}
		if (printable.startsWith('/')) {
			setHelp(false);
			return setLine(printable);
		}
		if (help && (key.escape || input === '?')) return setHelp(false);
		const action = hotkey(input, arrowOf(key), state, shown);
		if (!action) return;
		if (action.kind !== 'help') setHelp(false);
		apply(action);
	});

	// Header and footer keep their height; the panel between them takes what is left and clips.
	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Box justifyContent="space-between" flexShrink={0}>
				<Gradient colors={BRAND}>tigergrid</Gradient>
				<Text wrap="truncate-start">
					{state.metrics.map((metric) => (
						<Text key={metric} color={PALETTES[metric][state.theme][4]}>
							{metric}{' '}
						</Text>
					))}
					<Text dimColor>
						· {state.tool} · {state.cells} · {state.theme}
						{state.withGit ? '' : ' · no git'}
					</Text>
				</Text>
			</Box>
			<Box
				flexGrow={1}
				flexShrink={1}
				flexBasis={0}
				flexDirection="column"
				borderStyle="round"
				borderColor="gray"
				paddingX={1}
				overflow="hidden"
			>
				{help && <HelpPanel />}
				{!help && !loaded && <Spinner label="scanning transcripts and repos…" />}
				{!help && loaded && view && (
					<GraphPanel loaded={loaded} view={view} state={state} windowWeeks={windowWeeks} shown={shown} />
				)}
			</Box>
			<Box flexDirection="column" flexShrink={0}>
				{suggestions.map((command, index) => (
					<Text key={command.name} inverse={index === selected} wrap="truncate-end">
						{' '}
						{`${command.name} ${command.usage}`.padEnd(28)}
						<Text dimColor>{command.summary}</Text>
					</Text>
				))}
				{usage && <Text dimColor> {usage}</Text>}
				<Text wrap="truncate-end">
					<Text color="cyan">› </Text>
					{line}
					<Text inverse> </Text>
					{line ? '' : <Text dimColor> type / for commands, ? for help</Text>}
				</Text>
				<Box>
					{scanning && <Spinner label="scanning…" />}
					{!scanning && message && (
						<Text color={message.error ? 'red' : 'green'} wrap="truncate-end">
							{message.text}
						</Text>
					)}
					{!scanning && !message && loaded && (
						<Text dimColor wrap="truncate-end">
							scanned {loaded.claudeFiles} Claude + {loaded.codexFiles} Codex transcripts, {loaded.repos} repos in{' '}
							{loaded.seconds.toFixed(1)}s
						</Text>
					)}
				</Box>
				<Text dimColor wrap="truncate-end">
					{KEYS.map((key) => `${key.keys} ${key.label}`).join('  ')}
				</Text>
			</Box>
		</Box>
	);
}

/**
 * Open the TUI on the alternate screen and wait until the user leaves it (q, /quit or
 * ctrl+c). The terminal is restored on every way out, SIGTERM included.
 *
 * @returns resolves when the TUI has closed.
 * Called by: cli (main), with `--interactive`.
 * Calls: render (ink), App.
 */
export async function runTui(initial: TuiState, sources: LoadOptions): Promise<void> {
	const instance = render(<App initial={initial} sources={sources} />, {
		alternateScreen: true,
		incrementalRendering: true
	});
	await instance.waitUntilExit();
}
