import { describe, expect, test } from 'bun:test';
import type { TuiState } from '../types/tui';
import { DEFAULT_JSON, DEFAULT_SVG, hotkey, parseCommand, suggestionsFor, usageFor } from '../src/tui/commands';

const STATE: TuiState = {
	metrics: ['prompts'],
	tool: 'all',
	weeks: 'fit',
	cells: 'matrix',
	theme: 'dark',
	withGit: true
};

describe('parseCommand', () => {
	test('mirrors the CLI flags, validating the same way', () => {
		expect(parseCommand('/metric prompts,ai,prompts')).toEqual({
			kind: 'set',
			changes: { metrics: ['prompts', 'ai'] }
		});
		expect(parseCommand('/tool codex')).toEqual({ kind: 'set', changes: { tool: 'codex' } });
		expect(parseCommand('/weeks 26')).toEqual({ kind: 'set', changes: { weeks: 26 } });
		expect(parseCommand('/weeks fit')).toEqual({ kind: 'set', changes: { weeks: 'fit' } });
		expect(parseCommand('/cells wide')).toEqual({ kind: 'set', changes: { cells: 'wide' } });
		expect(parseCommand('/theme light')).toEqual({ kind: 'set', changes: { theme: 'light' } });
		expect(parseCommand('/git off')).toEqual({ kind: 'set', changes: { withGit: false } });
	});

	test('exports default to out/, or take a file', () => {
		expect(parseCommand('/svg')).toEqual({ kind: 'svg', file: DEFAULT_SVG });
		expect(parseCommand('/json  data/days.json ')).toEqual({ kind: 'json', file: 'data/days.json' });
	});

	test('bad arguments name the problem and the usage', () => {
		expect(parseCommand('/metric vibes')).toEqual({
			kind: 'error',
			message: 'unknown metric "vibes"; usage: /metric <name>[,<name>…]'
		});
		expect(parseCommand('/metric')).toEqual({
			kind: 'error',
			message: 'name a metric; usage: /metric <name>[,<name>…]'
		});
		expect(parseCommand('/weeks 0')).toMatchObject({ kind: 'error' });
		expect(parseCommand('/weeks two')).toMatchObject({ kind: 'error' });
		expect(parseCommand('/tool cursor')).toMatchObject({ kind: 'error' });
		expect(parseCommand('/git maybe')).toMatchObject({ kind: 'error' });
		expect(parseCommand('/nope')).toEqual({ kind: 'error', message: 'unknown command: /nope' });
	});
});

describe('hotkey', () => {
	test('arrows step through the metrics, wrapping, and a combined graph becomes a single one', () => {
		expect(hotkey('', 'right', STATE, 40)).toEqual({ kind: 'set', changes: { metrics: ['sessions'] } });
		expect(hotkey('', 'left', STATE, 40)).toEqual({ kind: 'set', changes: { metrics: ['ai'] } });
		expect(hotkey('', 'right', { ...STATE, metrics: ['tokens', 'ai'] }, 40)).toEqual({
			kind: 'set',
			changes: { metrics: ['commits'] }
		});
	});

	test('t, c, l and g cycle tool, cells, theme and git', () => {
		expect(hotkey('t', null, STATE, 40)).toEqual({ kind: 'set', changes: { tool: 'claude' } });
		expect(hotkey('t', null, { ...STATE, tool: 'codex' }, 40)).toEqual({ kind: 'set', changes: { tool: 'all' } });
		expect(hotkey('c', null, STATE, 40)).toEqual({ kind: 'set', changes: { cells: 'wide' } });
		expect(hotkey('l', null, STATE, 40)).toEqual({ kind: 'set', changes: { theme: 'light' } });
		expect(hotkey('g', null, STATE, 40)).toEqual({ kind: 'set', changes: { withGit: false } });
	});

	test('+ and - step four weeks from what is shown, never below one', () => {
		expect(hotkey('+', null, STATE, 40)).toEqual({ kind: 'set', changes: { weeks: 44 } });
		expect(hotkey('-', null, { ...STATE, weeks: 3 }, 40)).toEqual({ kind: 'set', changes: { weeks: 1 } });
	});

	test('exports, rescan, help and quit; other keys do nothing', () => {
		expect(hotkey('s', null, STATE, 40)).toEqual({ kind: 'svg', file: DEFAULT_SVG });
		expect(hotkey('j', null, STATE, 40)).toEqual({ kind: 'json', file: DEFAULT_JSON });
		expect(hotkey('r', null, STATE, 40)).toEqual({ kind: 'rescan' });
		expect(hotkey('?', null, STATE, 40)).toEqual({ kind: 'help' });
		expect(hotkey('q', null, STATE, 40)).toEqual({ kind: 'quit' });
		expect(hotkey('x', null, STATE, 40)).toBeNull();
	});
});

describe('suggestions', () => {
	test('list commands while the name is typed, then show its usage', () => {
		expect(suggestionsFor('/t').map((command) => command.name)).toEqual(['/tool', '/theme']);
		expect(suggestionsFor('/tool ')).toEqual([]);
		expect(usageFor('/tool ')).toBe('/tool <claude|codex|all>');
		expect(usageFor('/rescan')).toBe('/rescan');
		expect(suggestionsFor('tool')).toEqual([]);
	});
});
