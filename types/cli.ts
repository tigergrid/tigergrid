import type { Days, Tool } from './days';
import type { Grid, Metric, Summary } from './grid';

/** One row of `tigergrid --json`: a Day with Sets and Maps flattened to plain values. */
export interface JsonDay {
	date: string;
	sessions: Record<Tool, number>;
	prompts: Record<Tool, number>;
	tokens: Record<Tool, number>;
	commits: number;
	aiCommits: number;
	projects: Record<string, number>;
}

/** Where to read from; the CLI flags that pick sources. */
export interface LoadOptions {
	/** `--claude-dir`, resolved; undefined means `~/.claude/projects`. */
	claudeDir?: string;
	/** `--codex-dir`, resolved; undefined means `~/.codex`. */
	codexDir?: string;
	/** False with `--no-git`. */
	withGit: boolean;
	/** `--git-root` directories, resolved. */
	gitRoots: string[];
	/** `--author` patterns; undefined means `git config user.email`. */
	authors?: string[];
}

/** Everything loaded from the sources for one window, and what it took. */
export interface Loaded {
	days: Days;
	claudeFiles: number;
	codexFiles: number;
	repos: number;
	/** Wall time of the scan, in seconds. */
	seconds: number;
}

/** One line of the stats block under the graph; null is a blank line between groups. */
export type SummaryLine = { label: string; text: string } | null;

/** The graph for a list of metrics: one grid and one summary per metric, in order. */
export interface View {
	grids: [Metric, Grid][];
	summaries: [Metric, Summary][];
}
