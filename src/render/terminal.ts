import type { CellStyle, Grid, Metric, RenderOptions } from '../../types/grid';
import { METRIC_LABEL, monthLabels, PALETTES } from '../grid';

/**
 * Whether to draw in colour: stdout is a terminal and NO_COLOR is unset. Checked on every call
 * rather than once at import, so the answer never depends on which module loaded first.
 *
 * @returns true to colour.
 * Called by: dim, bold, fg, cell, renderBars.
 * Calls: nothing.
 */
const color = () => process.stdout.isTTY && !process.env.NO_COLOR;
const RESET = '\x1b[0m';
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
/** Bar glyphs for levels 0..4 in a combined graph: a grey baseline for 0, then rising blocks. */
const BARS = ['▁', '▂', '▄', '▆', '█'];
/** The same without colour, where a baseline would read as level 1. */
const BARS_MONO = ['·', '▂', '▄', '▆', '█'];

/**
 * Cell styles: the glyph drawn in colour, the shade characters used without colour (pipes,
 * NO_COLOR), and the width in columns per week. `matrix` (the default) is dense: a gap between
 * weeks only, so a busy week reads as one bar. `wide` leaves gaps between days and weeks.
 */
const CELLS: Record<CellStyle, { glyph: string; mono: string[]; width: number }> = {
	matrix: { glyph: '▐█', mono: [' ·', ' ░', ' ▒', ' ▓', ' █'], width: 2 },
	wide: { glyph: '▆▆ ', mono: [' · ', '░░ ', '▒▒ ', '▓▓ ', '██ '], width: 3 }
};

/**
 * Check that a CLI string names a cell style.
 *
 * @returns true (narrowing the type) for "matrix" or "wide".
 * Called by: cli.
 * Calls: nothing.
 */
export const isCellStyle = (value: string): value is CellStyle => value === 'wide' || value === 'matrix';

/**
 * Columns one week takes in a cell style, so the CLI can fit the window to the terminal.
 *
 * @returns 2 for `matrix`, 3 for `wide`.
 * Called by: cli, renderGrid.
 * Calls: nothing.
 */
export const cellWidth = (style: CellStyle): number => CELLS[style].width;

/**
 * Wrap text in ANSI dim, or leave it plain when stdout isn't a colour TTY.
 *
 * @returns the possibly-styled string.
 * Called by: renderGrid, cli.
 * Calls: color.
 */
export const dim = (text: string) => (color() ? `\x1b[2m${text}${RESET}` : text);

/**
 * Wrap text in ANSI bold, or leave it plain when stdout isn't a colour TTY.
 *
 * @returns the possibly-styled string.
 * Called by: cli.
 * Calls: color.
 */
export const bold = (text: string) => (color() ? `\x1b[1m${text}${RESET}` : text);

/**
 * Colour text with a 24-bit foreground from a `#rrggbb` hex string.
 *
 * @returns the string wrapped in truecolor escape codes, or unchanged without colour.
 * Called by: cell.
 * Calls: color.
 */
function fg(hex: string, text: string): string {
	if (!color()) return text;
	const rgb = parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}m${text}${RESET}`;
}

/**
 * Draw one grid cell: the style's glyph in the metric's colour for `level` from the light or
 * dark ramp, or the style's shade character when colour is off.
 *
 * @returns the cell string, always `cellWidth(options.cells)` columns wide.
 * Called by: renderGrid.
 * Calls: color, fg.
 */
function cell(metric: Metric, level: number, options: RenderOptions): string {
	const style = CELLS[options.cells];
	return color() ? fg(PALETTES[metric][options.theme][level]!, style.glyph) : style.mono[level]!;
}

/**
 * Build the month header line: each label above the first column of its month, dropped when
 * the next label would start too soon to fit it.
 *
 * @returns the header text (not yet dimmed).
 * Called by: renderGrid, renderBars.
 * Calls: monthLabels.
 */
function monthHeader(grid: Grid, width: number): string {
	const labels = [...monthLabels(grid)];
	let header = '    ';
	labels.forEach(([column, name], index) => {
		const next = labels[index + 1]?.[0] ?? Infinity;
		// A label takes 4 characters (space + 3 letters); skip it if the next one starts sooner.
		if ((next - column) * width < 4) return;
		header = header.padEnd(4 + column * width) + ' ' + name;
	});
	return header;
}

/**
 * Render the grid for the terminal: a month header, seven weekday rows (Sun..Sat, labelled Mon/Wed/Fri as on GitHub) with one
 * cell per week. Month labels that would collide with the next one are dropped;
 * future days are left blank. No legend: darker or brighter means more, as on GitHub.
 *
 * @returns the multi-line string, ready to print.
 * Called by: cli.
 * Calls: monthHeader, cell, cellWidth, dim.
 */
export function renderGrid(grid: Grid, metric: Metric, options: RenderOptions): string {
	const width = cellWidth(options.cells);
	const lines: string[] = [dim(monthHeader(grid, width))];

	for (let row = 0; row < 7; row++) {
		let line = dim(WEEKDAYS[row]!.padEnd(4));
		for (const column of grid.weeks) {
			const day = column[row]!;
			line += day.future ? ' '.repeat(width) : cell(metric, day.level, options);
		}
		lines.push(line);
	}
	return lines.join('\n');
}

/**
 * Columns one week takes in a combined graph: one bar per metric, then a gap.
 *
 * @returns `metrics + 1`.
 * Called by: cli, renderBars.
 * Calls: nothing.
 */
export const barsWidth = (metrics: number): number => metrics + 1;

/**
 * Render several metrics as one terminal graph: the same month header and weekday rows as
 * renderGrid, but each day is a run of bars, one per metric in the given order. A bar's height
 * is that metric's level (quartiles over its own active days, so metrics on different scales
 * compare) and its colour is the metric's; level 0 is a grey baseline. A legend line names the
 * bars, since without colour only their order tells them apart. The grids must share a window.
 *
 * @returns the multi-line string, ready to print.
 * Called by: cli.
 * Calls: monthHeader, barsWidth, color, fg, dim.
 */
export function renderBars(grids: [Metric, Grid][], options: Pick<RenderOptions, 'theme'>): string {
	const [first] = grids;
	if (!first) return '';
	const lines: string[] = [dim(monthHeader(first[1], barsWidth(grids.length)))];
	/** One metric's bar for one day. Called by: renderBars. Calls: color, fg. */
	const bar = (metric: Metric, level: number) => {
		if (!color()) return BARS_MONO[level]!;
		const ramp = PALETTES[metric][options.theme];
		return fg(level ? ramp[4]! : ramp[0]!, BARS[level]!);
	};

	for (let row = 0; row < 7; row++) {
		let line = dim(WEEKDAYS[row]!.padEnd(4));
		first[1].weeks.forEach((_, week) => {
			const future = first[1].weeks[week]![row]!.future;
			line += ' ' + grids.map(([metric, grid]) => (future ? ' ' : bar(metric, grid.weeks[week]![row]!.level))).join('');
		});
		lines.push(line);
	}

	const legend = color()
		? grids.map(([metric]) => `${fg(PALETTES[metric][options.theme][4]!, '█')} ${dim(METRIC_LABEL[metric])}`).join('  ')
		: dim(`bars, left to right: ${grids.map(([metric]) => METRIC_LABEL[metric]).join(' · ')}`);
	lines.push('', `    ${legend}`);
	return lines.join('\n');
}
