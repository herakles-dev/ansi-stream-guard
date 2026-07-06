/**
 * A per-stream stateful transform that guards a chunked byte stream carrying
 * ANSI/VT output (a PTY, a tmux pipe, a WebSocket relay) before it reaches a
 * terminal emulator such as xterm.js.
 *
 * Two jobs:
 *  (a) Never let a chunk end mid-escape-sequence. PTY chunking and any
 *      coalescing layer in between can split a CSI/OSC/DCS sequence across two
 *      reads; if the split lands between chunks, the consumer sees a dangling
 *      ESC on one message and a stray tail on the next, which corrupts terminal
 *      state. The guard holds back the incomplete tail until it completes.
 *  (b) Strip alt-screen toggles (`\x1b[?1049h/l`, `\x1b[?1047h/l`,
 *      `\x1b[?47h/l`) even when split across chunks. tmux emits these on
 *      attach; letting one reach xterm.js flips it to the alternate buffer,
 *      which zeroes scrollback.
 *
 * Pure and deterministic — no timers, no DOM APIs, no dependencies.
 */

// Alt-screen private-mode toggles. Exact single-mode match only — combined
// private-mode lists (e.g. `\x1b[?25l?1049h`) aren't a single CSI sequence
// and terminfo/tmux don't emit them that way, so we don't need to parse
// multi-mode lists.
const ALT_SCREEN_TOGGLE_REGEX = /\x1b\[\?(?:1049|1047|47)[hl]/g;

// How long we'll hold back a trailing "incomplete" escape sequence before
// giving up and emitting it raw. Keeps a stray bare ESC from swallowing
// output forever if the terminating byte never arrives.
const MAX_HOLDBACK = 64;

/**
 * Single-pass scan of `buf` as an escape-sequence state machine. Returns
 * the index where a dangling, not-yet-terminated escape sequence begins,
 * or -1 if `buf` ends in "ground" state (nothing left open).
 *
 * This has to be a real scan rather than `lastIndexOf('\x1b')` + local
 * checks: an OSC/DCS sequence's own ST terminator is itself `ESC \`, so a
 * chunk boundary can land exactly between that ESC and its backslash —
 * `lastIndexOf` would then find that trailing ESC and misread it as a
 * fresh (complete, 2-byte) sequence, releasing the still-open OSC/DCS
 * prefix ahead of it as if it were plain text.
 */
export function findDanglingEscapeStart(buf: string): number {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    if (buf.charCodeAt(i) !== 0x1b) {
      i++;
      continue;
    }

    if (i + 1 >= n) return i; // bare ESC, nothing after it yet

    const intro = buf[i + 1];

    if (intro === '[') {
      // CSI: ESC [ params(0x30-0x3f)* intermediate(0x20-0x2f)* final(0x40-0x7e)
      let j = i + 2;
      while (j < n) {
        const code = buf.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break; // final byte
        j++;
      }
      if (j >= n) return i; // no final byte yet — dangling
      i = j + 1;
      continue;
    }

    if (intro === ']') {
      // OSC: ESC ] ... (BEL | ST)
      const bel = buf.indexOf('\x07', i + 2);
      const st = buf.indexOf('\x1b\\', i + 2);
      const end = bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st !== -1 ? st + 2 : -1;
      if (end === -1) return i; // unterminated — dangling
      i = end;
      continue;
    }

    if (intro === 'P' || intro === '_' || intro === '^') {
      // DCS / APC / PM: ESC {P|_|^} ... ST
      const st = buf.indexOf('\x1b\\', i + 2);
      if (st === -1) return i; // dangling
      i = st + 2;
      continue;
    }

    // Generic two-byte escape (ESC + one other char, e.g. ESC c, ESC =,
    // ESC 7) — complete as soon as that one char has arrived.
    i += 2;
  }
  return -1; // fully settled — nothing left open
}

export class AnsiStreamGuard {
  private carry = '';

  /**
   * Feed a chunk of output through the guard. Returns everything safe to emit
   * now — the held-back remainder from the previous call plus `chunk`, minus a
   * trailing incomplete escape sequence (if any), with alt-screen toggles
   * stripped. May return '' if the whole chunk was held back.
   */
  push(chunk: string): string {
    let buf = this.carry + chunk;
    this.carry = '';

    const dangling = findDanglingEscapeStart(buf);
    if (dangling !== -1) {
      const tail = buf.slice(dangling);
      if (tail.length <= MAX_HOLDBACK) {
        buf = buf.slice(0, dangling);
        this.carry = tail;
      }
      // else: runaway holdback — a stray ESC can't swallow output forever;
      // emit everything raw (buf already contains it) and stay reset.
    }

    return buf.replace(ALT_SCREEN_TOGGLE_REGEX, '');
  }

  /**
   * Returns any held-back remainder and clears it. Call on stream
   * close/disconnect so a partial sequence isn't silently dropped.
   */
  flush(): string {
    const remainder = this.carry;
    this.carry = '';
    return remainder;
  }
}
