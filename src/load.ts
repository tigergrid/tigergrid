import type { Loaded, LoadOptions } from '../types/cli';
import type { Days } from '../types/days';
import { loadClaude } from './sources/claude';
import { loadCodex } from './sources/codex';
import { gitOutput, loadGit } from './sources/git';

/**
 * Pick the git author filters: the `--author` patterns if given, else the global
 * `git config user.email`, else no filter (all authors).
 *
 * @returns author patterns for `git log --author`.
 * Called by: loadSources.
 * Calls: gitOutput (git config).
 */
async function gitAuthors(authors: string[] | undefined): Promise<string[]> {
	if (authors?.length) return authors;
	const email = (await gitOutput(process.cwd(), ['config', 'user.email'])).trim();
	return email ? [email] : [];
}

/**
 * Load every source in parallel from `since` (a day key) to today: Claude Code transcripts,
 * Codex rollouts and, unless `withGit` is off, the git repos under the roots.
 *
 * @returns the merged days, how many files and repos were read, and the scan's wall time.
 * Called by: cli (main), tui (App).
 * Calls: loadClaude, loadCodex, gitAuthors, loadGit.
 */
export async function loadSources(options: LoadOptions, since: string): Promise<Loaded> {
	const days: Days = new Map();
	const started = performance.now();
	const [claudeFiles, codexFiles, repos] = await Promise.all([
		loadClaude(days, since, options.claudeDir),
		loadCodex(days, since, options.codexDir),
		options.withGit
			? gitAuthors(options.authors).then((authors) => loadGit(days, since, options.gitRoots, authors))
			: Promise.resolve(0)
	]);
	return { days, claudeFiles, codexFiles, repos, seconds: (performance.now() - started) / 1000 };
}
