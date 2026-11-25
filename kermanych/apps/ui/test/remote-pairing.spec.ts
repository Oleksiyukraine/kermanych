import { describe, expect, it } from 'vitest';
import { remotePairingLeft } from '../src/lib/settings';

// «Пульт» → «Підключити телефон»: the countdown under the one-time code. The risk is at the
// edges — a `0:00` while the code still works, a code shown as live after it lapsed, or a broken
// timestamp read as «never expires».
describe('remotePairingLeft', () => {
  const at = Date.parse('2026-11-24T12:00:00.000Z');
  const exp = (ms: number) => new Date(at + ms).toISOString();

  it('formats minutes and zero-padded seconds', () => {
    expect(remotePairingLeft(exp(10 * 60_000), at)).toBe('10:00');
    expect(remotePairingLeft(exp(65_000), at)).toBe('1:05');
  });

  it('rounds a part of a second up, so a live code never reads 0:00', () => {
    expect(remotePairingLeft(exp(1), at)).toBe('0:01');
    expect(remotePairingLeft(exp(59_001), at)).toBe('1:00');
  });

  it('is undefined once the code has run out', () => {
    expect(remotePairingLeft(exp(0), at)).toBeUndefined();
    expect(remotePairingLeft(exp(-5_000), at)).toBeUndefined();
  });

  it('treats an unreadable expiry as expired', () => {
    expect(remotePairingLeft('not a date', at)).toBeUndefined();
  });
});
