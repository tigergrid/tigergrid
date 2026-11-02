#!/usr/bin/env bun
// Spike: can an Ink 8 app run as a `bun build --compile` binary? Exercises the parts a
// tigergrid TUI needs: fullscreen (alternate screen), raw-mode keyboard input, a slash-command
// prompt with suggestions, terminal resize, Ctrl+C teardown, a hand-rolled table, a coloured
// grid using the real palettes, and the stale-but-popular add-ons (@inkjs/ui, ink-gradient).
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { ProgressBar, Spinner } from '@inkjs/ui';
import Gradient from 'ink-gradient';
import { useEffect, useState } from 'react';
import { PALETTES } from '../../../src/grid';

type View = 'grid' | 'table' | 'scan' | 'help';

type Command = { name: string; summary: string };

const COMMANDS: Command[] = [
	{ name: '/grid', summary: 'contribution grid (real palettes, synthetic data)' },
	{ name: '/table', summary: 'commit → issue mapping table' },
	{ name: '/scan', summary: 'simulated slow scan with spinner + progress bar' },
	{ name: '/help', summary: 'list commands' },
	{ name: '/quit', summary: 'exit' }
];

const MAPPINGS = [
	{ commit: '5335cb8', issue: 'GRID-41', agent: 'claude', subject: 'test: prove the CLI makes no network connections' },
	{ commit: 'c7b1576', issue: 'GRID-38', agent: 'claude', subject: 'feat(svg:all): pass -m lists through' },
	{ commit: '39a9e33', issue: 'GRID-38', agent: 'codex', subject: 'feat: combined SVG card for several metrics' },
	{ commit: '7829150', issue: '—', agent: 'none', subject: 'docs: README example for a combined graph' },
	{ commit: '524bc9c', issue: 'GRID-35', agent: 'claude', subject: 'feat: combined terminal graph for several metrics' }
];

/**
 * Commands whose name starts with what has been typed, for the suggestion list.
 *
 * @returns matching commands; empty unless the line starts with `/`.
 * Called by: App.
 * Calls: nothing.
 */
const suggestionsFor = (line: string): Command[] =>
	line.startsWith('/') ? COMMANDS.filter((command) => command.name.startsWith(line)) : [];

/**
 * Deterministic pseudo-random activity level 0..4 for a grid cell, so the grid looks the same
 * on every run (the harness compares frames).
 *
 * @returns the level for week `week`, weekday `weekday`.
 * Called by: GridView.
 * Calls: nothing.
 */
function level(week: number, weekday: number): number {
	const noise = Math.sin(week * 12.9898 + weekday * 78.233) * 43758.5453;
	return Math.floor((noise - Math.floor(noise)) * 5);
}

/**
 * The contribution grid: as many weeks as fit the width, two columns per cell.
 *
 * @returns a 7-row grid of coloured blocks.
 * Called by: App.
 * Calls: level.
 */
function GridView({ columns }: { columns: number }) {
	const weeks = Math.max(1, Math.min(53, Math.floor((columns - 4) / 2)));
	const ramp = PALETTES.prompts.dark;
	return (
		<Box flexDirection="column">
			<Text dimColor>{weeks} weeks · prompts</Text>
			{[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
				<Text key={weekday}>
					{Array.from({ length: weeks }, (_, week) => (
						<Text key={week} color={ramp[level(week, weekday)]}>
							██
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

/**
 * A plain flexbox table: fixed columns for hash/issue/agent, the subject takes the rest and
 * truncates. This is what replaces the abandoned ink-table.
 *
 * @returns the commit → issue table.
 * Called by: App.
 * Calls: nothing.
 */
function TableView() {
	const header = { commit: 'commit', issue: 'issue', agent: 'agent', subject: 'subject' };
	return (
		<Box flexDirection="column">
			{[header, ...MAPPINGS].map((row, index) => (
				<Box key={row.commit} gap={2}>
					<Box width={8} flexShrink={0}>
						<Text bold={index === 0} color={index === 0 ? undefined : 'yellow'}>
							{row.commit}
						</Text>
					</Box>
					<Box width={8} flexShrink={0}>
						<Text bold={index === 0}>{row.issue}</Text>
					</Box>
					<Box width={7} flexShrink={0}>
						<Text bold={index === 0} dimColor={row.agent === 'none'}>
							{row.agent}
						</Text>
					</Box>
					<Box flexGrow={1}>
						<Text bold={index === 0} wrap="truncate-end">
							{row.subject}
						</Text>
					</Box>
				</Box>
			))}
		</Box>
	);
}

/**
 * A fake slow scan: progress ticks every 50 ms until 100, then reports done.
 *
 * @returns spinner + progress bar, then a done line.
 * Called by: App.
 * Calls: setInterval.
 */
function ScanView() {
	const [progress, setProgress] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setProgress((current) => Math.min(100, current + 5)), 50);
		return () => clearInterval(timer);
	}, []);
	if (progress >= 100) return <Text color="green">scan done · 1,234 sessions</Text>;
	return (
		<Box flexDirection="column" gap={1}>
			<Spinner label={`scanning transcripts… ${progress}%`} />
			<Box width={40}>
				<ProgressBar value={progress} />
			</Box>
		</Box>
	);
}

/**
 * The command list.
 *
 * @returns one line per command.
 * Called by: App.
 * Calls: nothing.
 */
function HelpView() {
	return (
		<Box flexDirection="column">
			{COMMANDS.map((command) => (
				<Text key={command.name}>
					<Text color="cyan">{command.name.padEnd(8)}</Text>
					<Text dimColor>{command.summary}</Text>
				</Text>
			))}
		</Box>
	);
}

/**
 * The fullscreen shell: header, the current view, suggestions, a prompt and a status line.
 * Input is handled here rather than with @inkjs/ui's TextInput so Tab/arrows can drive the
 * suggestion list.
 *
 * @returns the whole screen, sized to the terminal.
 * Called by: module top level (render).
 * Calls: useInput, useWindowSize, suggestionsFor, the views.
 */
function App() {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [line, setLine] = useState('');
	const [selected, setSelected] = useState(0);
	const [view, setView] = useState<View>('help');
	const [message, setMessage] = useState('type / for commands · ctrl+c to quit');
	const [lastKey, setLastKey] = useState('');
	const suggestions = suggestionsFor(line);

	/**
	 * Run a submitted line as a command.
	 *
	 * @returns nothing; switches the view, sets a message or exits.
	 * Called by: App's input handler.
	 * Calls: exit, setView, setMessage.
	 */
	function run(submitted: string) {
		const name = submitted.trim();
		if (name === '/quit') return exit();
		const command = COMMANDS.find((candidate) => candidate.name === name);
		if (!command) return setMessage(`unknown command: ${name || '(empty)'}`);
		setView(name.slice(1) as View); // COMMANDS minus /quit are exactly the View names
		setMessage(`ran ${name}`);
	}

	useInput((input, key) => {
		setLastKey(JSON.stringify(input) + (key.ctrl ? ' ctrl' : '') + (key.tab ? ' tab' : ''));
		if (key.return) {
			run(suggestions[selected] && line !== suggestions[selected].name ? suggestions[selected].name : line);
			setLine('');
			setSelected(0);
			return;
		}
		if (key.tab && suggestions[selected]) {
			setLine(suggestions[selected].name);
			return;
		}
		if (key.upArrow) return setSelected((current) => Math.max(0, current - 1));
		if (key.downArrow) return setSelected((current) => Math.min(suggestions.length - 1, current + 1));
		if (key.escape) return setLine('');
		if (key.backspace || key.delete) {
			setLine((current) => current.slice(0, -1));
			setSelected(0);
			return;
		}
		// A multi-character chunk (a paste) arrives as one `input` with key.return false, newline
		// included; strip control characters so a pasted line never smuggles a \r into the prompt.
		const printable = input.replace(/[\x00-\x1f\x7f]/g, ''); // eslint-disable-line no-control-regex
		if (printable && !key.ctrl && !key.meta) {
			setLine((current) => current + printable);
			setSelected(0);
		}
	});

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Box justifyContent="space-between">
				<Gradient colors={['#8fd12a', '#3667e6', '#d63d7c']}>tigergrid · ink spike</Gradient>
				<Text dimColor>
					{columns}x{rows}
				</Text>
			</Box>
			<Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} overflow="hidden">
				{view === 'grid' && <GridView columns={columns - 4} />}
				{view === 'table' && <TableView />}
				{view === 'scan' && <ScanView />}
				{view === 'help' && <HelpView />}
			</Box>
			{suggestions.map((command, index) => (
				<Text key={command.name} inverse={index === selected}>
					{' '}
					{command.name.padEnd(8)} <Text dimColor>{command.summary}</Text>
				</Text>
			))}
			<Text>
				<Text color="cyan">› </Text>
				{line}
				<Text inverse> </Text>
			</Text>
			<Box justifyContent="space-between">
				<Text dimColor>{message}</Text>
				<Text dimColor>key: {lastKey}</Text>
			</Box>
		</Box>
	);
}

const instance = render(<App />, { alternateScreen: true, incrementalRendering: true });
await instance.waitUntilExit();
// Back on the primary screen: proves teardown restored it (the harness looks for this line).
console.log('tigergrid spike: exited cleanly');
