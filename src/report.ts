import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { JsonDay, SummaryLine, View } from '../types/cli';
import type { Day, Days, Tool } from '../types/days';
import type { CellStyle, Grid, Metric, Summary, ToolFilter } from '../types/grid';
import { buildGrid, fmt, METRIC_LABEL, summarize } from './grid';
import { renderBarsSvg, renderSvg } from './render/svg';
import { dim } from './render/terminal';

// What the CLI prints and the TUI shows, computed once for both: the graph's grids and
// summaries, the headline, the stats block, the JSON rows and the SVG file.

export const TOOL_LABEL: Record<ToolFilter, string> = {
	all: 'Claude Code + Codex',
	claude: 'Claude Code',
	codex: 'Codex'
};

/**
 * Whether a metric counts git commits rather than agent activity.
 *
 * @returns true for `commits` and `ai`.
 * Called by: scopeOf.
 * Calls: nothing.
 */
const isGitMetric = (metric: Metric) => metric === 'commits' || metric === 'ai';

/**
 * Build the graph for a list of metrics over the same window: one grid and summary each.
 *
 * @returns the grids and summaries, in the order of `metrics`.
 * Called by: cli (main), tui (App).
 * Calls: buildGrid, summarize.
 */
export function buildView(days: Days, metrics: Metric[], filter: ToolFilter, weeks: number): View {
	const grids = metrics.map((metric): [Metric, Grid] => [metric, buildGrid(days, metric, filter, weeks)]);
	return { grids, summaries: grids.map(([metric, grid]): [Metric, Summary] => [metric, summarize(grid)]) };
}

/**
 * Name what a graph covers: `git` when every metric is a git metric, the tool label plus
 * `+ git` when some are, else the tool label alone.
 *
 * @returns the scope label, and whether the graph is about git alone.
 * Called by: cli (main), tui (App), writeSvg.
 * Calls: isGitMetric.
 */
export function scopeOf(metrics: Metric[], filter: ToolFilter): { scope: string; gitOnly: boolean } {
	const gitOnly = metrics.every(isGitMetric);
	if (gitOnly) return { scope: 'git', gitOnly };
	return { scope: metrics.some(isGitMetric) ? `${TOOL_LABEL[filter]} + git` : TOOL_LABEL[filter], gitOnly };
}

/**
 * The headline above the graph: each metric's total, e.g. `8 prompts · 3 AI-assisted commits`.
 *
 * @returns the totals text, unstyled.
 * Called by: cli (main), tui (App).
 * Calls: fmt.
 */
export const totalsLine = (view: View): string =>
	view.summaries.map(([metric, { total }]) => `${fmt(total)} ${METRIC_LABEL[metric]}`).join(' · ');

/**
 * Select the aggregates that fall inside a grid's window (start to today).
 *
 * @returns the in-window days, in no particular order.
 * Called by: summaryLines.
 * Calls: nothing.
 */
const daysInView = (days: Days, grid: Grid): Day[] =>
	[...days.entries()].filter(([key]) => key >= grid.start && key <= grid.end).map(([, day]) => day);

/**
 * The stats block under the graph: streaks and busiest day for the chosen metric (one line
 * of active days and streaks per metric for a combined graph), then window totals for every
 * source regardless of metric (sessions/prompts/tokens per tool, commits and the AI-assisted
 * share) and the top five projects by prompts.
 *
 * @returns the lines in order, null for a blank line between groups.
 * Called by: cli (printSummary), tui (App).
 * Calls: daysInView, fmt, dim; the local helpers sum and sessions.
 */
export function summaryLines(days: Days, view: View, filter: ToolFilter, withGit: boolean): SummaryLine[] {
	const [first, ...more] = view.summaries;
	const grid = view.grids[0]?.[1];
	if (!first || !grid) return [];
	const inView = daysInView(days, grid);
	/** Sum a per-day quantity over the visible window. Called by: summaryLines. Calls: nothing. */
	const sum = (pick: (day: Day) => number) => inView.reduce((total, day) => total + pick(day), 0);
	/** Count distinct sessions of one tool in the window (a session spanning days counts once). Called by: summaryLines. Calls: nothing. */
	const sessions = (tool: Tool) => new Set(inView.flatMap((day) => [...day.sessions[tool]])).size;
	const lines: SummaryLine[] = [];

	if (!more.length) {
		const [, summary] = first;
		lines.push({ label: 'active days', text: `${summary.activeDays} / ${summary.totalDays}` });
		lines.push({ label: 'streak', text: `${summary.currentStreak}d current · ${summary.longestStreak}d longest` });
		const { busiest } = summary;
		if (busiest) lines.push({ label: 'busiest day', text: `${busiest.key} (${fmt(busiest.value)})` });
	} else {
		for (const [metric, summary] of view.summaries) {
			lines.push({
				label: metric,
				text: `${summary.activeDays} / ${summary.totalDays} active days · ${summary.currentStreak}d current · ${summary.longestStreak}d longest streak`
			});
		}
	}
	lines.push(null);
	for (const tool of ['claude', 'codex'] as const) {
		if (filter !== 'all' && filter !== tool) continue;
		lines.push({
			label: TOOL_LABEL[tool],
			text: `${fmt(sessions(tool))} sessions · ${fmt(sum((day) => day.prompts[tool]))} prompts · ${fmt(sum((day) => day.tokens[tool]))} tokens`
		});
	}
	if (withGit) {
		const commits = sum((day) => day.commits);
		const aiCommits = sum((day) => day.aiCommits);
		const share = commits ? Math.round((aiCommits / commits) * 100) : 0;
		lines.push({ label: 'git', text: `${fmt(commits)} commits · ${fmt(aiCommits)} AI-assisted (${share}%)` });
	}

	const projects = new Map<string, number>();
	for (const day of inView) {
		for (const [project, prompts] of day.projects) projects.set(project, (projects.get(project) ?? 0) + prompts);
	}
	const top = [...projects].sort((left, right) => right[1] - left[1]).slice(0, 5);
	if (top.length) {
		lines.push({
			label: 'top projects',
			text: top.map(([project, prompts]) => `${project} ${dim(String(prompts))}`).join(dim(' · '))
		});
	}
	return lines;
}

/**
 * Flatten one day's Sets and Maps into plain counts and objects for JSON output.
 *
 * @returns the JSON row for that day.
 * Called by: jsonRows.
 * Calls: nothing.
 */
const toJsonDay = (date: string, aggregate: Day): JsonDay => ({
	date,
	sessions: { claude: aggregate.sessions.claude.size, codex: aggregate.sessions.codex.size },
	prompts: aggregate.prompts,
	tokens: aggregate.tokens,
	commits: aggregate.commits,
	aiCommits: aggregate.aiCommits,
	projects: Object.fromEntries(aggregate.projects)
});

/**
 * Every loaded day as a JSON row, sorted by date. This is the `--json` output.
 *
 * @returns the rows.
 * Called by: cli (main), tui (App).
 * Calls: toJsonDay.
 */
export const jsonRows = (days: Days): JsonDay[] =>
	[...days.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([date, aggregate]) => toJsonDay(date, aggregate));

/**
 * Write every loaded day as JSON (the `--json` rows) to a file, creating its directory.
 *
 * @returns the absolute path written.
 * Called by: tui (App).
 * Calls: jsonRows, mkdir, writeFile.
 */
export async function writeJson(file: string, days: Days): Promise<string> {
	const path = resolve(file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(jsonRows(days), null, 2) + '\n');
	return path;
}

/**
 * Write the graph as an SVG card: one metric's grid, or the combined bars for several.
 * Creates the file's directory if needed.
 *
 * @returns the absolute path written.
 * Called by: cli (main), tui (App).
 * Calls: scopeOf, renderSvg, renderBarsSvg, mkdir, writeFile.
 */
export async function writeSvg(file: string, view: View, filter: ToolFilter, cells: CellStyle): Promise<string> {
	const path = resolve(file);
	const metrics = view.grids.map(([metric]) => metric);
	const { scope, gitOnly } = scopeOf(metrics, filter);
	const title = gitOnly ? 'Git activity' : `Agent activity · ${scope}`;
	const [first] = view.grids;
	const [firstSummary] = view.summaries;
	if (!first || !firstSummary) throw new Error('nothing to draw: no metric selected');
	const svg =
		view.grids.length > 1
			? renderBarsSvg(
					view.grids,
					view.summaries.map(([, summary]) => summary),
					title
				)
			: renderSvg(first[1], first[0], firstSummary[1], title, { cells });
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, svg);
	return path;
}
