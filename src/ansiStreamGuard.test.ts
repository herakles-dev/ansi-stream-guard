import { describe, it, expect } from 'vitest';
import { AnsiStreamGuard } from './ansiStreamGuard.js';

describe('AnsiStreamGuard', () => {
  it('reassembles a CSI sequence split across two push() calls', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('\x1b[')).toBe('');
    expect(guard.push('2K')).toBe('\x1b[2K');
  });

  it('strips \\x1b[?1049h split across chunks, preserving surrounding text', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('before\x1b[?10')).toBe('before');
    expect(guard.push('49hafter')).toBe('after');
  });

  it('strips \\x1b[?1049l, \\x1b[?1047h/l, and \\x1b[?47h/l whole (not split)', () => {
    const cases = ['\x1b[?1049l', '\x1b[?1047h', '\x1b[?1047l', '\x1b[?47h', '\x1b[?47l'];
    for (const seq of cases) {
      const guard = new AnsiStreamGuard();
      expect(guard.push(`x${seq}y`)).toBe('xy');
    }
  });

  it('passes normal text through byte-identical', () => {
    const guard = new AnsiStreamGuard();
    const text = 'the quick brown fox jumps over the lazy dog 12345 !@#$%^&*()';
    expect(guard.push(text)).toBe(text);
  });

  it('passes braille spinner glyphs through byte-identical', () => {
    const guard = new AnsiStreamGuard();
    const text = '⣾ Thinking…';
    expect(guard.push(text)).toBe(text);
  });

  it('passes the ✳-family spinner glyph through byte-identical', () => {
    const guard = new AnsiStreamGuard();
    const text = '✳ Cogitating… (esc to interrupt · 12s)';
    expect(guard.push(text)).toBe(text);
  });

  it('survives an OSC title sequence split across chunks', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('\x1b]0;my tit')).toBe('');
    expect(guard.push('le\x07after')).toBe('\x1b]0;my title\x07after');
  });

  it('survives an OSC ST-terminated sequence split across chunks', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('\x1b]8;;https://example.com\x1b')).toBe('');
    expect(guard.push('\\link')).toBe('\x1b]8;;https://example.com\x1b\\link');
  });

  it('never permanently swallows output: holdback cap releases a runaway sequence', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('\x1b[')).toBe('');
    // 100 param-byte-only chars (digits), never supplying a CSI final byte
    // (0x40-0x7e), so the sequence stays "incomplete" past the 64-char cap.
    const runaway = '1'.repeat(100);
    const out = guard.push(runaway);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toBe('\x1b[' + runaway);
  });

  it('holds a bare trailing ESC and releases it once a follow-up char disambiguates it', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('hello\x1b')).toBe('hello');
    // ESC + 'c' (RIS reset) is a complete generic 2-byte escape.
    expect(guard.push('cworld')).toBe('\x1bcworld');
  });

  it('flush() returns and clears the held-back remainder', () => {
    const guard = new AnsiStreamGuard();
    expect(guard.push('\x1b[2')).toBe('');
    expect(guard.flush()).toBe('\x1b[2');
    expect(guard.flush()).toBe('');
  });

  it('flush() returns empty string when nothing is held back', () => {
    const guard = new AnsiStreamGuard();
    guard.push('plain text');
    expect(guard.flush()).toBe('');
  });
});
