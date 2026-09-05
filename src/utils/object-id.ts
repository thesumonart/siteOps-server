import { Types } from 'mongoose';

/**
 * ObjectId helpers.
 *
 * User-supplied identifiers reach the database layer as strings from URLs and
 * request bodies. `new Types.ObjectId(value)` throws on malformed input, and an
 * unhandled throw inside a query builder turns a 404 into a 500 — so every
 * conversion at a trust boundary goes through `toObjectId`, which returns null
 * instead.
 */

export function isValidObjectId(value: string): boolean {
  return (
    Types.ObjectId.isValid(value) && new Types.ObjectId(value).toHexString() === value.toLowerCase()
  );
}

export function toObjectId(value: string): Types.ObjectId | null {
  if (!isValidObjectId(value)) return null;
  return new Types.ObjectId(value);
}

/** For values already validated upstream (schema-parsed input, internal ids). */
export function toObjectIdOrThrow(value: string): Types.ObjectId {
  const objectId = toObjectId(value);
  if (!objectId) throw new Error('Invalid ObjectId');
  return objectId;
}

export function objectIdToString(value: Types.ObjectId): string {
  return value.toHexString();
}

export { Types };
