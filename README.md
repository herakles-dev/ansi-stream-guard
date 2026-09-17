# ansi-stream-guard

A tiny, dependency-free guard for a **chunked byte stream carrying ANSI/VT output** — a PTY, a tmux pipe, a WebSocket relay — placed *before* the bytes reach a terminal emulator like [xterm.js](https://xtermjs.org/).

It does exactly two things, and nothing else:

1. **Never emits a chunk that ends mid-escape-sequence.** It holds back a trailing incomplete `CSI` / `OSC` / `DCS` sequence until the terminating byte arrives.
2. **Strips alt-screen toggles** (`\x1b[?1049h/l`, `\x1b[?1047h/l`, `\x1b[?47h/l`) — even when the toggle itself is split across two chunks.

Pure, deterministic, no timers, no DOM, no dependencies. ~130 lines.

Not on npm yet — install straight from GitHub, or vendor the file:

```bash
npm install github:herakles-dev/ansi-stream-guard
```

`npm install` builds it on the way in (the `prepare` script runs `tsc`), so `dist/` doesn't need to be committed.

Or skip the dependency entirely — it's one file with no imports:

```bash
curl -o ansiStreamGuard.ts https://raw.githubusercontent.com/herakles-dev/ansi-stream-guard/main/src/ansiStreamGuard.ts
```

```ts
import { AnsiStreamGuard } from 'ansi-stream-guard';

const guard = new AnsiStreamGuard();

pty.onData((chunk) => {
  const safe = guard.push(chunk); // '' if the whole chunk was held back
  if (safe) ws.send(safe);
});

pty.onExit(() => {
  const tail = guard.flush(); // release any held-back remainder
  if (tail) ws.send(tail);
});
```

## Why this exists

This was extracted from a browser-based terminal that runs **Claude Code** (and other TUIs) inside tmux and streams the PTY over a WebSocket. Claude Code's thinking-spinner — `✳ Cogitating…`, rewritten many times a second with bare carriage returns — rendered as duplicated lines, and scrollback silently died.

The instinct is to *filter*: strip the stray `·`, drop the lone `…`, swallow the bad frame. Every filter fixed one glitch and spawned two, because the stream was never wrong — the boundaries were. Two real bugs hid under the filters:

### 1. A split escape sequence corrupts terminal state

PTY chunking (and any coalescing layer you add for throughput) can split a single escape sequence across two reads. If the boundary lands mid-sequence, the emulator sees a dangling `ESC` on one message and a stray tail on the next, and repaints garbage.

The subtle part is *detecting* the split. You can't just `lastIndexOf('\x1b')` — an `OSC`/`DCS` sequence is terminated by `ST`, which is itself `ESC \`. A chunk boundary can land between that `ESC` and its `\`, so `lastIndexOf` finds the terminator's ESC and misreads it as a fresh, complete two-byte escape — releasing the still-open sequence ahead of it as plain text. So the guard runs a real single-pass escape-sequence state machine (`findDanglingEscapeStart`) and holds back only a genuinely-open tail (capped at 64 chars, so a stray ESC can never swallow output forever).

### 2. A leaked alt-screen toggle kills scrollback

tmux emits `\x1b[?1049h` on attach. Let one reach xterm.js and it flips to the **alternate screen buffer**, where `scrollableLines` is permanently `0` — scroll just stops working, with no error. The guard strips these toggles across the join, so a boundary landing inside `\x1b[?10` / `49h` can't sneak one through.

## Companion technique (not in this package): column-stable glyph rendering

The guard fixes the *stream*. If you render to the DOM (one `<span>` per run of cells) rather than a canvas, spinner glyphs cause a second, independent problem worth documenting:

> Non-ASCII glyphs (spinner frames `✳ ✻ ✽`, braille `⣾`, CJK, emoji) render at a **fallback-font advance** that differs from your measured monospace `charWidth`. In a natural-flow row, that drift pushes every subsequent column sideways and the whole line wobbles frame-to-frame.

The fix is to break rows into runs on ASCII-ness: printable-ASCII keeps the fast path; each non-ASCII run gets pinned to its exact column span.

```ts
// width = number of terminal cells the run occupies × pixel width of one column
const width = cellCount * charWidth;
return `<span style="display:inline-block;width:${width}px;overflow:hidden;vertical-align:top">${text}</span>`;
```

(Wide-character lookahead — CJK/emoji counting as two cells — feeds `cellCount`.) This lives in the source terminal's DOM renderer, not here, but it's the other half of "render faithfully instead of filtering."

## API

| Member | Signature | Notes |
| --- | --- | --- |
| `new AnsiStreamGuard()` | — | One instance per stream; it's stateful. |
| `.push(chunk)` | `(chunk: string) => string` | Returns bytes safe to emit now (prev held-back remainder + `chunk`, minus a trailing incomplete escape, alt-screen toggles stripped). May return `''`. |
| `.flush()` | `() => string` | Returns and clears any held-back remainder. Call on close/disconnect. |
| `findDanglingEscapeStart(buf)` | `(buf: string) => number` | Exported for testing: index where an open escape sequence begins, or `-1`. |

## Scope / non-goals

- Operates on `string`. Decode bytes to UTF-8 first (and keep one decoder per stream so multi-byte code points aren't split — a separate concern from escape sequences).
- Doesn't parse or rewrite terminal semantics; it only guards boundaries and removes three specific private-mode toggles.
- Combined private-mode lists (`\x1b[?25l?1049h`) aren't matched — terminfo/tmux don't emit alt-screen toggles that way.

## Develop

```bash
npm install
npm test        # vitest — 12 cases covering split CSI/OSC/DCS, toggle stripping, holdback cap, flush
npm run build   # tsc → dist/
```

## License

MIT
