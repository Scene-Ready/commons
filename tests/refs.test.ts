import { describe, expect, it } from 'vitest';
import { formatRef, isRef, parseRef } from '../src/refs';

describe('cross-app references', () => {
  it('parses and formats a reference', () => {
    const ref = parseRef('sr:platform:location:loc_123');
    expect(ref).toEqual({ app: 'platform', type: 'location', id: 'loc_123' });
    expect(formatRef(ref!)).toBe('sr:platform:location:loc_123');
  });

  it('accepts multi-word types', () => {
    expect(parseRef('sr:platform:corrective_action:tsk-9')?.type).toBe('corrective_action');
  });

  it.each([
    'platform:location:loc_123',
    'sr:platform:location',
    'sr:platform:location:a:b',
    'sr:Platform:location:1',
    'sr:platform:location:',
    'sr:platform:location:has space',
    'x:platform:location:1',
  ])('rejects %s', (value) => {
    expect(parseRef(value)).toBeNull();
    expect(isRef(value)).toBe(false);
  });

  it('refuses to format a part it could not parse back', () => {
    expect(() => formatRef({ app: 'platform', type: 'location', id: 'a:b' })).toThrow(TypeError);
  });
});
