import { describe, expect, it } from 'vitest';
import { nextAttemptAt } from '../src/outbox';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const SECOND = 1000;

describe('nextAttemptAt', () => {
  it('waits 30 seconds after the first failure, doubling with each one after', () => {
    // A jitter of 0.5 is the midpoint: no adjustment.
    expect(nextAttemptAt(1, NOW, 0.5)).toBe(NOW + 30 * SECOND);
    expect(nextAttemptAt(2, NOW, 0.5)).toBe(NOW + 60 * SECOND);
    expect(nextAttemptAt(7, NOW, 0.5)).toBe(NOW + 1920 * SECOND);
  });

  it('caps the delay at one hour', () => {
    expect(nextAttemptAt(8, NOW, 0.5)).toBe(NOW + 3600 * SECOND);
    expect(nextAttemptAt(40, NOW, 0.5)).toBe(NOW + 3600 * SECOND);
  });

  it('reaches the eighth attempt about an hour after the first', () => {
    // Waits after failures 1 to 7, with no jitter: 30 s doubling to 32 min.
    let at = NOW;
    for (let failures = 1; failures <= 7; failures++) at = nextAttemptAt(failures, at, 0.5);
    expect(at - NOW).toBe(3810 * SECOND);
  });

  it('spreads attempts by up to 20% either way', () => {
    expect(nextAttemptAt(1, NOW, 0)).toBe(NOW + 24 * SECOND);
    expect(nextAttemptAt(1, NOW, 1)).toBe(NOW + 36 * SECOND);
    expect(nextAttemptAt(40, NOW, 1)).toBe(NOW + 4320 * SECOND);
  });

  it('picks its own jitter when none is given', () => {
    for (let i = 0; i < 50; i++) {
      const at = nextAttemptAt(3, NOW);
      expect(at).toBeGreaterThanOrEqual(NOW + 96 * SECOND);
      expect(at).toBeLessThanOrEqual(NOW + 144 * SECOND);
    }
  });
});
