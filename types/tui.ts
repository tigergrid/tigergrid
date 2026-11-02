import type { CellStyle, Metric, TerminalTheme, ToolFilter } from './grid';

/** What the TUI shows; the CLI flags set its starting values. */
export interface TuiState {
	metrics: Metric[];
	tool: ToolFilter;
	/** A fixed window from `--weeks` or `/weeks`, or 'fit' to fill the terminal width. */
	weeks: number | 'fit';
	cells: CellStyle;
	theme: TerminalTheme;
	/** False with `--no-git` or `/git off`. */
	withGit: boolean;
}

/** What a hotkey or a `/` command asks the TUI to do. */
export type TuiAction =
	| { kind: 'set'; changes: Partial<TuiState> }
	| { kind: 'svg'; file: string }
	| { kind: 'json'; file: string }
	| { kind: 'rescan' }
	| { kind: 'help' }
	| { kind: 'quit' }
	| { kind: 'error'; message: string };

/** One hotkey: what to press, a one-word label for the key bar, and what it does. */
export interface TuiKey {
	keys: string;
	label: string;
	summary: string;
}

/** One `/` command, for the suggestion list and the help screen. */
export interface TuiCommand {
	name: string;
	/** What it takes, e.g. `<claude|codex|all>`; empty when nothing. */
	usage: string;
	summary: string;
	/** The CLI flag it mirrors, e.g. `-t`; empty when none. */
	flag: string;
}
