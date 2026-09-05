import { describe, expect, it } from 'vitest';

import { isValidObjectId, toObjectId } from './object-id.js';

describe('toObjectId', () => {
  it('accepts a 24-character hex string', () => {
    const value = '507f1f77bcf86cd799439011';
    expect(toObjectId(value)?.toHexString()).toBe(value);
  });

  it('returns null instead of throwing on malformed input', () => {
    expect(toObjectId('')).toBeNull();
    expect(toObjectId('not-an-id')).toBeNull();
    expect(toObjectId('507f1f77bcf86cd79943901')).toBeNull();
    expect(toObjectId('../../../etc/passwd')).toBeNull();
  });

  it('rejects 12-character strings that the driver would silently coerce', () => {
    // Types.ObjectId.isValid('websites1234') is true because any 12-byte string
    // is a legal ObjectId. Accepting it would let a crafted path segment match
    // a document, so the round-trip check rejects it.
    expect(isValidObjectId('websites1234')).toBe(false);
    expect(toObjectId('websites1234')).toBeNull();
  });
});
