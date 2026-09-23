import { describe, expect, it } from 'vitest';
import { isTypeCompatible } from './typeSystem';

describe('typed port compatibility', () => {
  it('accepts identical types', () => expect(isTypeCompatible('pdf', 'pdf')).toBe(true));
  it('accepts child types for parent inputs', () => {
    expect(isTypeCompatible('pdf', 'document')).toBe(true);
    expect(isTypeCompatible('pdf', 'file')).toBe(true);
  });
  it('rejects unsafe reverse and unrelated conversions', () => {
    expect(isTypeCompatible('file', 'pdf')).toBe(false);
    expect(isTypeCompatible('text', 'pdf')).toBe(false);
    expect(isTypeCompatible('trigger', 'file')).toBe(false);
  });
  it('connects triggers only to trigger inputs', () => {
    expect(isTypeCompatible('trigger', 'trigger')).toBe(true);
  });
});
