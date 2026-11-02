# TigerGrid

[![CI](https://github.com/Lemontiger26/tigergrid/actions/workflows/ci.yml/badge.svg)](https://github.com/Lemontiger26/tigergrid/actions/workflows/ci.yml)

A GitHub-style contribution graph of your AI coding agents: Claude Code and Codex sessions, prompts and tokens, plus the share of your git commits that agents co-authored. Everything is read locally; nothing leaves the machine (`test/network.test.ts` runs every CLI mode under strace and fails on any network connection).

```sh
bun install
bun start                    # prompts, last ~52 weeks (fits terminal width)
bun start -m sessions        # pick the metric: prompts | sessions | tokens | commits | ai
bun start -m tokens -t codex # ...and the tool: claude | codex | all
bun start -m prompts,sessions,ai  # several metrics in one graph
```

With a comma list of metrics, each day becomes a run of bars, one per metric in the order given: a bar's height is that metric's level and its colour is the metric's. A legend under the graph names the bars, and the summary shows active days and streaks per metric. `--svg` draws the same bars, with one tooltip per day listing every metric.

Run `bun start --help` for all flags.

### Interactive

```sh
bun start -i                 # or: bun run tui, tigergrid -i
bun start -i -m tokens -t codex   # the other flags set where it starts
```

`-i` opens a fullscreen TUI with the same graph, stats and exports. Keys switch what's shown: `← →` metric, `t` tool, `c` cells, `l` light/dark, `+ -` four weeks more or fewer, `g` git on/off, `s` / `j` write `out/tigergrid.svg` / `.json`, `r` rescan, `?` help, `q` quit. Type `/` for commands that mirror the flags: `/metric prompts,sessions,ai`, `/tool codex`, `/weeks 26` (or `fit`), `/cells wide`, `/theme light`, `/git off`, `/svg [file]`, `/json [file]`. When the window is wider than the terminal, the graph shows the most recent weeks that fit and the stats still cover the whole window. How it's built and tested: [docs/TUI.md](docs/TUI.md).

### Exports

| Script            | Output                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `bun run svg`     | `out/tigergrid.svg`, 53 weeks of prompts. Extra flags pass through: `bun run svg -m tokens -t claude`       |
| `bun run svg:all` | `out/tigergrid-<metric>.svg` for all five metrics. Extra flags pass through: `bun run svg:all --cells wide`. `-m prompts,sessions,ai` writes just those, plus their combined graph `tigergrid-prompts-sessions-ai.svg` |
| `bun run json`    | `out/tigergrid.json`, per-day sessions/prompts/tokens/commits/projects. Flags pass through too.             |

SVGs follow the viewer's `prefers-color-scheme`. Each metric has its own colour: lime (prompts), blue (sessions), violet (tokens), mint (commits), rose (AI-assisted commits). Light ramps run from pastel tag fills to saturated tag text; dark ramps go from dim tints to neon on a near-black card. Colours live in `PALETTES` / `THEME` in `src/grid.ts`.

## Sources and counting rules

| Source      | Location                                                                                   | Notes                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `~/.claude/projects/**/*.jsonl` (`--claude-dir`)                                           | Prompts = human user turns (no tool results, slash-command echoes, meta or sidechain messages). Usage is deduplicated by message id because one response spans several lines.                          |
| Codex       | `~/.codex/sessions`, `~/.codex/archived_sessions` (`--codex-dir` sets the `~/.codex` part) | Prompts = `task_started` turns outside sub-agent threads. Threads listed in `external_agent_session_imports.json` are skipped: they are copies of Claude Code sessions, already counted at the source. |
| git         | repos under `--git-root` (default `~/develop`, depth 4)                                    | Filtered by `--author` (default `git config user.email`), deduplicated by hash across worktrees. "AI-assisted" = an agent `Co-Authored-By` trailer or a `Generated with …` footer.                     |

`tokens` means fresh tokens: uncached input + cache writes + output. Cache reads are excluded because they would swamp everything else.

## Node.js

The runtime uses Node.js APIs and supports Node.js 22.17 or newer. Bun remains the
build tool and test runner. Build and run the JavaScript CLI with:

```sh
bun run build:node
node dist/node/cli.js --help
bun run test:node # run CLI integration tests under Node.js
```

The npm CLI entry point uses this JavaScript build; packing builds it automatically.
The package does not yet expose a public parser API.

Grid’s intended boundary is resolving agent activity to repositories. Applications consuming its data own
any higher-level grouping of repositories into projects. The current daily export
still uses shortened working-directory labels; canonical repository resolution and
session-level exports are planned.

## Standalone binaries

`bun run build` compiles single-file executables into `dist/` (no Bun needed to run them), plus `dist/SHA256SUMS`:

| Binary                   | Platform               |
| ------------------------ | ---------------------- |
| `tigergrid-darwin-arm64` | macOS on Apple silicon |
| `tigergrid-linux-x64`    | Linux x86-64 (glibc)   |
| `tigergrid-linux-arm64`  | Linux ARM64 (glibc)    |

`bun scripts/build.ts bun-linux-x64` builds a single target. `tigergrid --version` prints the version and the commit the binary was built from (`-dirty` if the working tree had uncommitted changes). Compiled binaries ignore `.env` and `bunfig.toml` files in the directory they run from. CI builds and smoke-tests each binary on matching hardware and attaches them to the run.

`bun run smoke` does the same on your machine: it builds all three, runs the one matching your OS and CPU natively and the Linux ones in Docker containers of their architecture (`debian:bookworm-slim`, emulated where the CPU differs), and checks `--version`, the fixture numbers, the terminal output and an SVG in each cell style. `bun scripts/smoke.ts bun-linux-x64` checks a single target; CI runs it that way on each platform. Targets that can't run locally, like the macOS binary on Linux, are skipped.

## Development

```sh
bun test              # unit tests per module + end-to-end CLI runs against the fixtures
bun run check         # typecheck src/, test/ and types/
bun run lint          # type-aware ESLint with the conventions in docs/CONVENTIONS.md
bun run format        # Prettier (format:check only checks)
bun run precommit     # all four, as the husky pre-commit hook runs them
```

TypeScript provides type checking and typescript-eslint support. Exported types live in `types/`; transcript records are read as `unknown` and narrowed through `src/json.ts`.

The fixtures in [`test/fixtures/`](test/fixtures/README.md) are a small fictional week of activity, with every expected number written down so you can check the tests against them.

## Known limits

- Claude Code deletes transcripts after `cleanupPeriodDays` (default 30), so history only goes back as far as you've kept it. Raise that setting if you want a full year.
- Codex's legacy→paginated history migration restamped some old threads with the migration time. Imported threads are filtered out; any remaining native ones show up on the migration date.
- Levels are GitHub-style quartiles over the active days in view, so colours are relative, not absolute.

## License

[Apache-2.0](LICENSE).
