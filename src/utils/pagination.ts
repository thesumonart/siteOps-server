import { ApiError } from '../errors/ApiError.js';
import { toObjectId, type Types } from './object-id.js';

/**
 * Opaque cursors for newest-first monitoring feeds.
 *
 * The cursor pairs a timestamp with a document id rather than carrying the
 * timestamp alone. Checks and incidents are written by a worker that processes
 * a whole batch concurrently, so two documents genuinely can share a
 * millisecond; a timestamp-only cursor would silently skip one of them or
 * return it twice. The id breaks the tie, and because ObjectIds from the same
 * millisecond still order consistently, paging is stable.
 *
 * It is base64url of `<epoch ms>.<hex id>` — encoded so clients treat it as
 * opaque and do not build their own, not as a security measure. Anything it
 * decodes to is still applied inside a tenant-scoped query, so a forged cursor
 * can only move a caller around within data they can already read.
 */
export interface DecodedCursor {
  readonly timestamp: Date;
  readonly id: Types.ObjectId;
}

export function encodeCursor(timestamp: Date, id: Types.ObjectId): string {
  const raw = `${String(timestamp.getTime())}.${id.toHexString()}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or throws a validation error.
 *
 * A malformed cursor is a client bug worth surfacing: silently restarting from
 * the newest page would look to the user like a list that jumps back to the
 * top on its own.
 */
export function decodeCursor(cursor: string): DecodedCursor {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('.');

  if (separator > 0) {
    const milliseconds = Number(raw.slice(0, separator));
    const id = toObjectId(raw.slice(separator + 1));

    if (Number.isSafeInteger(milliseconds) && id) {
      return { timestamp: new Date(milliseconds), id };
    }
  }

  throw ApiError.validation('The page cursor is not valid.', [
    { field: 'cursor', message: 'Must be a cursor returned by a previous request.' },
  ]);
}

export function decodeOptionalCursor(cursor: string | undefined): DecodedCursor | undefined {
  return cursor === undefined ? undefined : decodeCursor(cursor);
}

/**
 * The filter that continues a newest-first sort on `(field, _id)`.
 *
 * Expressed as `$or` because MongoDB has no tuple comparison: take everything
 * strictly older than the cursor's timestamp, plus anything sharing that exact
 * timestamp whose id sorts before the cursor's.
 */
export function cursorFilter(field: string, cursor: DecodedCursor): Record<string, unknown> {
  return {
    $or: [
      { [field]: { $lt: cursor.timestamp } },
      { [field]: cursor.timestamp, _id: { $lt: cursor.id } },
    ],
  };
}
