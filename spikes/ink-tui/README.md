# Spike: Ink 8 in a compiled Bun binary

**Question:** can tigergrid's interactive TUI be built on Ink (React for terminals) and still ship as a `bun build --compile` executable for darwin-arm64, linux-arm64 and linux-x64?

**Answer: yes**, with one build-time workaround (below). On linux-x64, an end-to-end test on a real pseudo-terminal passes 10/10, five runs in a row, in about 2.3 s.

## What's here

| File | Purpose |
|---|---|
| `src/app.tsx` | Fullscreen Ink app: slash-command prompt with suggestions (Tab completes, ↑/↓ select), `/grid` (real `PALETTES` from `src/grid.ts`, synthetic data), `/table` (hand-rolled commit → issue table), `/scan` (spinner + progress bar from `@inkjs/ui`), `ink-gradient` header, live size readout |
| `build.ts` | Compiles all three targets with the same options as `scripts/build.ts` |
| `test/tui.test.ts` | Runs the binary on a real pseudo-terminal (`Bun.Terminal`), mirrors its output into a headless xterm.js (`@xterm/headless`), types keys, resizes, sends Ctrl+C / SIGTERM, and checks the rendered screen and the terminal state afterwards |

```bash
bun install && bun build.ts
bun test
```

The test picks the binary for the machine it runs on (`dist/spike-<os>-<arch>`), or `TUI_BINARY` if set. It skips when the binary isn't there, so `bun test` at the repo root, which also picks this file up, passes before anyone has built the spike.

Try it by hand: `./dist/spike-linux-x64`, then type `/`.

## Results (linux-x64, Bun 1.4.4, Ink 8.0.0, React 19.3)

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

**Not run:** linux-arm64 and darwin-arm64 build fine (correct ELF aarch64 / Mach-O arm64), but this machine can't execute them (no arm64 sysroot for qemu, no Mac). The JS bundle is identical across targets, so the risk is low. To close that gap, run `bun test` on the CI runners that already build each target (`Bun.Terminal` works on macOS too, and the test knows macOS's termios flag values).

## Findings to carry into the real build

1. **`react-devtools-core` must be stubbed.** Ink dynamically imports it when `DEV=true`. Both obvious fixes fail:
   - `--define process.env.DEV="false"` alone: **build fails**. Bun resolves dynamic imports before dropping the dead branch.
   - `--external react-devtools-core`: **builds, but the binary crashes at startup** (`Cannot find package 'react-devtools-core' from '/$bunfs/root/…'`). Bun hoists the external import to the top level.
   - What works: a `Bun.build` plugin that resolves the package to an empty module, plus the `DEV` define so a user's `DEV=true` does nothing. That means `scripts/build.ts` moves from spawning `bun build` to the `Bun.build({ compile: … })` API (see `build.ts`).
2. **Pastes arrive as one `input`.** A multi-character chunk reaches `useInput` as a single string with `key.return === false`, newline included. So a pasted newline doesn't submit (good), but the app has to strip control characters itself or `\r` ends up in the prompt.
3. **Ink 8 covers what we were going to hand-roll:** `alternateScreen`, `incrementalRendering` (redraws only changed lines; our flicker worry), `maxFps` (default 30), `useWindowSize`, `overflow` + `contentOffsetY` for scrolling, and kitty keyboard protocol support.
4. **Use our own input handling, not `@inkjs/ui`'s `TextInput`.** We need to drive the suggestion list with Tab and arrow keys, and that's ~30 lines with `useInput`. `@inkjs/ui` is still fine for spinners and progress bars.
5. **Tables are DIY.** `ink-table` was last released in 2023, for Ink 3. A `<Box>` per column with fixed widths for hash/issue/agent and `wrap="truncate-end"` for the subject was ~40 lines.
6. **`Bun.Terminal` plus `@xterm/headless` make a cheap end-to-end test inside `bun test`.** `test/tui.test.ts` is a template for TUI tests in CI. It catches teardown regressions (terminal left in raw mode or on the alternate screen) that unit tests can't see. Because it reads xterm's active buffer, it can also check directly that the app is on the alternate screen while running and back on the normal one after exit.
7. **`Bun.spawn({ terminal })` doesn't give the child a controlling terminal** (Bun 1.4.4: no `setsid`/`TIOCSCTTY`; `ps` shows `TT ?`). Resizing the pty therefore sends no SIGWINCH. The test sends SIGWINCH itself after `terminal.resize()`, and the app then reads the new size from the pty as usual. Real terminals aren't affected: the shell gives the app a controlling terminal. The same gap means a test can't check Ctrl+C as a kernel signal (`ISIG`), only as the `\x03` byte Ink reads in raw mode, which is the path that matters for an Ink app.
