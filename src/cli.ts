#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { LoadOptions, SummaryLine } from '../types/cli';
import type { CellStyle, Metric, TerminalTheme, ToolFilter } from '../types/grid';
import { dayKey } from './days';
import { gridStart, isMetric, isToolFilter } from './grid';
import { loadSources } from './load';
import { buildView, jsonRows, scopeOf, summaryLines, totalsLine, writeSvg } from './report';
import { barsWidth, bold, cellWidth, dim, isCellStyle, renderBars, renderGrid } from './render/terminal';
import { detectTheme, isTerminalTheme } from './render/theme';
import pkg from '../package.json';

const HELP = `TigerGrid — a contribution graph of your AI coding agents

Usage: tigergrid [options]

  -m, --metric <name>   prompts | sessions | tokens | commits | ai   (default: prompts)
                        or a comma list (prompts,sessions,ai) for one combined graph
  -t, --tool <name>     claude | codex | all                          (default: all)
  -w, --weeks <n>       weeks to show (default: fit terminal, max 53)
  -r, --git-root <dir>  where to look for git repos, repeatable      (default: ~/develop)
  -a, --author <pat>    git author filter, repeatable                (default: git config user.email)
      --claude-dir <d>  Claude Code projects dir                     (default: ~/.claude/projects)
      --codex-dir <d>   Codex home dir                               (default: ~/.codex)
      --no-git          skip the git scan
      --svg <file>      also write an embeddable SVG
      --json            print per-day data as JSON instead of the graph
      --cells <style>   matrix | wide                                (default: matrix)
      --theme <name>    light | dark                                 (default: ask the terminal)
  -i, --interactive     open the interactive TUI; the other flags set where it starts
  -v, --version         print the version and the commit it was built from
  -h, --help

Sources: Claude Code transcripts, Codex rollouts, and git repos under --git-root.
"tokens" counts fresh tokens (uncached input + cache writes + output); cache reads are excluded.
"ai" counts commits carrying an agent Co-Authored-By trailer or a "Generated with" footer.
A combined graph draws one bar per metric per day; its height is that metric's level.`;

const { values: args } = parseArgs({
	options: {
		metric: { type: 'string', short: 'm', default: 'prompts' },
		tool: { type: 'string', short: 't', default: 'all' },
		weeks: { type: 'string', short: 'w' },
		'git-root': { type: 'string', short: 'r', multiple: true },
		author: { type: 'string', short: 'a', multiple: true },
		'claude-dir': { type: 'string' },
		'codex-dir': { type: 'string' },
		'no-git': { type: 'boolean', default: false },
		svg: { type: 'string' },
		json: { type: 'boolean', default: false },
		cells: { type: 'string', default: 'matrix' },
		theme: { type: 'string' },
		interactive: { type: 'boolean', short: 'i', default: false },
		version: { type: 'boolean', short: 'v', default: false },
		help: { type: 'boolean', short: 'h', default: false }
	}
});

/**
 * The `--version` line. Compiled binaries carry the commit they were built from
 * (scripts/build.ts sets process.env.TIGERGRID_COMMIT at compile time); running from
 * source says `dev`.
 *
 * @returns e.g. `tigergrid 0.1.0 (3d9b5ea)`.
 * Called by: main.
 * Calls: nothing.
 */
const versionLine = () => `tigergrid ${pkg.version} (${process.env.TIGERGRID_COMMIT ?? 'dev'})`;

/**
 * Abort on invalid input: print the message to stderr and the usage text to stdout, exit with code 1.
 *
 * @returns never.
 * Called by: main (argument validation).
 * Calls: console.error, process.exit.
 */
function die(message: string): never {
	// Only the error goes to stderr (terminals often colour it); the usage text is ordinary output.
	console.error(`tigergrid: ${message}`);
	console.log(`\n${HELP}`);
	process.exit(1);
}

/**
 * Print the stats block under the graph, one aligned `label  value` line each.
 *
 * @returns nothing; writes to stdout.
 * Called by: main.
 * Calls: dim.
 */
function printSummary(lines: SummaryLine[]) {
	for (const line of lines) console.log(line ? `  ${dim(line.label.padEnd(16))}${line.text}` : '');
}

/**
 * Entry point: validate flags, then either open the TUI, or load all sources in parallel from
 * the start of the grid window and dump JSON or print the graph and summary, writing the SVG
 * if asked.
 *
 * @returns resolves when output is written or the TUI closes; exits early on `--help`, bad flags, or `--json`.
 * Called by: module top level.
 * Calls: versionLine, die, isMetric, isToolFilter, isCellStyle, isTerminalTheme, cellWidth, barsWidth, detectTheme,
 *        runTui (tui/app, loaded on demand), loadSources, jsonRows, buildView, scopeOf, totalsLine, renderGrid,
 *        renderBars, summaryLines, printSummary, writeSvg.
 */
async function main() {
	if (args.version) {
		console.log(versionLine());
		process.exit(0);
	}
	if (args.help) {
		console.log(HELP);
		process.exit(0);
	}
	const metrics: Metric[] = [];
	for (const name of args.metric.split(',').map((part) => part.trim())) {
		if (!isMetric(name)) die(`unknown metric "${name}"`);
		if (!metrics.includes(name)) metrics.push(name);
	}
	const [metric] = metrics;
	if (!metric) die('--metric needs at least one metric');
	const combined = metrics.length > 1;
	if (!isToolFilter(args.tool)) die(`unknown tool "${args.tool}"`);
	const filter: ToolFilter = args.tool;
	if (!isCellStyle(args.cells)) die(`unknown cell style "${args.cells}"`);
	const cells: CellStyle = args.cells;
	if (args.theme !== undefined && !isTerminalTheme(args.theme)) die(`unknown theme "${args.theme}"`);

	const weekWidth = combined ? barsWidth(metrics.length) : cellWidth(cells);
	const fitWeeks = Math.floor(((process.stdout.columns || 110) - 6) / weekWidth);
	const weeks = args.weeks ? Number(args.weeks) : Math.max(4, Math.min(53, fitWeeks));
	if (!Number.isInteger(weeks) || weeks < 1) die(`--weeks must be a positive integer`);

	const withGit = !args['no-git'];
	const sources: LoadOptions = {
		claudeDir: args['claude-dir'] ? resolve(args['claude-dir']) : undefined,
		codexDir: args['codex-dir'] ? resolve(args['codex-dir']) : undefined,
		withGit,
		gitRoots: (args['git-root'] ?? [join(homedir(), 'develop')]).map((root) => resolve(root)),
		authors: args.author
	};

	if (args.interactive) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) die('--interactive needs a terminal');
		// Ask before Ink takes over stdin: the question reads the terminal's reply from it.
		const theme: TerminalTheme = args.theme ?? (await detectTheme());
		// Loaded on demand, so the plain CLI never pays for React and Ink at startup.
		const { runTui } = await import('./tui/app');
		await runTui({ metrics, tool: filter, weeks: args.weeks ? weeks : 'fit', cells, theme, withGit }, sources);
		return;
	}

	const { days, claudeFiles, codexFiles, repos, seconds } = await loadSources(sources, dayKey(gridStart(weeks)));

	if (args.json) {
		console.log(JSON.stringify(jsonRows(days), null, 2));
		return;
	}

	const view = buildView(days, metrics, filter, weeks);
	const { scope } = scopeOf(metrics, filter);
	console.log();
	console.log(`  ${bold(totalsLine(view))} ${dim(`in the last ${weeks} weeks · ${scope}`)}`);
	console.log();
	// Only ask the terminal for its background when the grid is actually drawn.
	const theme: TerminalTheme = args.theme ?? (await detectTheme());
	console.log(combined ? renderBars(view.grids, { theme }) : renderGrid(view.grids[0]![1], metric, { cells, theme }));
	console.log();
	printSummary(summaryLines(days, view, filter, withGit));
	console.log();
	console.log(
		dim(`  scanned ${claudeFiles} Claude + ${codexFiles} Codex transcripts, ${repos} repos in ${seconds.toFixed(1)}s`)
	);

	if (args.svg) console.log(dim(`  wrote ${await writeSvg(args.svg, view, filter, cells)}`));
	console.log();
}

await main();
