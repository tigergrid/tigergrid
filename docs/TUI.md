# The TUI: Ink 8 in a compiled Bun binary

`tigergrid -i` opens a fullscreen TUI built on Ink (React for terminals). It ships inside the same standalone binaries as the CLI; the npm package is the parsers only. This page explains how it's built and tested, and what the spike that preceded it found.

## Where it lives

| File | Purpose |
|---|---|
| `src/tui/app.tsx` | The Ink app: header with the current settings, the graph panel (the CLI's own `renderGrid` / `renderBars` output and stats), the help panel, the `/` prompt with suggestions, a status line and the key bar. Loaded on demand, so the plain CLI never starts React |
| `src/tui/commands.ts` | Pure input handling: `/` commands that mirror the CLI flags, hotkeys, suggestions. Unit-tested in `test/tui-commands.test.ts` |
| `src/load.ts`, `src/report.ts` | What the CLI and the TUI share: loading the sources; the graph, headline, stats, JSON rows and SVG file |
| `scripts/build.ts` | Compiles the binaries, with the `react-devtools-core` stub (finding 1) |
| `test/tui.test.ts` | Runs `tigergrid -i` against the fixtures on a real pseudo-terminal (`Bun.Terminal`), mirrors its output into a headless xterm.js (`@xterm/headless`), types keys and commands, writes exports, resizes, sends Ctrl+C / SIGTERM, and checks the rendered screen and the terminal state afterwards |

The pty test runs from source in `bun test`, and against each compiled binary in CI's `binaries` job (`TIGERGRID_TUI_BINARY`), on linux-x64, linux-arm64 and darwin-arm64.

## Spike results (linux-x64, Bun 1.4.4, Ink 8.0.0, React 19.3)

The spike asked whether the TUI could be built on Ink and still ship as a `bun build --compile` executable for all three targets. It could, with one build-time workaround (finding 1).

| Check | Result |
|---|---|
| First frame | ~90–155 ms compiled (~240 ms via `bun src/app.tsx`) |
| Alternate screen in / out (`alternateScreen: true`) | ✅ |
| Raw-mode keyboard input in the compiled binary | ✅ |
| Slash suggestions, Tab completion, Enter | ✅ |
| Resize (SIGWINCH) re-lays out; table truncates with `…`; grid shrinks to fit | ✅ |
| 24-bit colour from the existing palettes | ✅ |
| Timer-driven redraws (spinner + progress at 20 updates/s, `incrementalRendering`) | ✅ |
| Ctrl+C → exit 0, primary screen restored, echo/canonical mode restored, cursor shown | ✅ |
| `/quit` → same clean teardown | ✅ |
| SIGTERM → terminal restored | ✅ |
| `@inkjs/ui` 2.0 (last release May 2024) and `ink-gradient` 4 work with Ink 8 | ✅ |
| Binary size | Ink + React add ~0.6 MB minified JS; the binary stays ~105 MB (linux) / ~86 MB (darwin), which is Bun's runtime |

**darwin-arm64** (macOS, Bun 1.4.4): 10/10 pass; first frame ~66 ms, or ~1 s on the first launch of a freshly built binary while macOS checks it. linux-arm64 and darwin-arm64 also passed in CI on Bun 1.4.3.

## Findings, and what the build does about them

1. **`react-devtools-core` must be stubbed.** Ink dynamically imports it when `DEV=true`. Both obvious fixes fail:
   - `--define process.env.DEV="false"` alone: **build fails**. Bun resolves dynamic imports before dropping the dead branch.
   - `--external react-devtools-core`: **builds, but the binary crashes at startup** (`Cannot find package 'react-devtools-core' from '/$bunfs/root/…'`). Bun hoists the external import to the top level.
   - What works: a `Bun.build` plugin that resolves the package to an empty module, plus the `DEV` define so a user's `DEV=true` does nothing. `scripts/build.ts` passes both to the `Bun.build` API instead of spawning `bun build`.
2. **Pastes arrive as one `input`.** A multi-character chunk reaches `useInput` as a single string with `key.return === false`, newline included. So a pasted newline doesn't submit (good), but the app has to strip control characters itself or `\r` ends up in the prompt.
3. **Ink 8 covers what we were going to hand-roll:** `alternateScreen`, `incrementalRendering` (redraws only changed lines; our flicker worry), `maxFps` (default 30), `useWindowSize`, `overflow` + `contentOffsetY` for scrolling, and kitty keyboard protocol support.
4. **Use our own input handling, not `@inkjs/ui`'s `TextInput`.** We need to drive the suggestion list with Tab and arrow keys, and that's ~30 lines with `useInput`. `@inkjs/ui` is still fine for spinners and progress bars.
5. **Tables are DIY.** `ink-table` was last released in 2023, for Ink 3. A `<Box>` per column with fixed widths for hash/issue/agent and `wrap="truncate-end"` for the subject was ~40 lines.
6. **`Bun.Terminal` plus `@xterm/headless` make a cheap end-to-end test inside `bun test`.** `test/tui.test.ts` is a template for TUI tests in CI. It catches teardown regressions (terminal left in raw mode or on the alternate screen) that unit tests can't see. Because it reads xterm's active buffer, it can also check directly that the app is on the alternate screen while running and back on the normal one after exit.
7. **`Bun.spawn({ terminal })` doesn't give the child a controlling terminal** (Bun 1.4.4: no `setsid`/`TIOCSCTTY`; `ps` shows `TT ?`). Resizing the pty therefore sends no SIGWINCH. The test sends SIGWINCH itself after `terminal.resize()`, and the app then reads the new size from the pty as usual. Real terminals aren't affected: the shell gives the app a controlling terminal. The same gap means a test can't check Ctrl+C as a kernel signal (`ISIG`), only as the `\x03` byte Ink reads in raw mode, which is the path that matters for an Ink app.
8. **A panel taller than the screen must not shrink.** Yoga gives every child `flexShrink: 1`, so when the help or graph panel is taller than the frame, its lines are squeezed to zero height and drawn over each other, and the footer lands on the frame's border. The panels set `flexShrink={0}` so the frame clips them; the frame itself is `flexGrow={1} flexBasis={0}` between a header and footer that keep their height.
