import type { NextFunction, Request, Response } from 'express';
import { Error as MongooseError, mongo } from 'mongoose';
import { ZodError } from 'zod';

import type { ApiErrorBody, ApiFieldError } from '../contracts/index.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import { logger } from '../utils/logger.js';
import { ApiError } from './ApiError.js';
import { codeForStatus, messageForCode } from './error-codes.js';

/**
 * The terminal error handler.
 *
 * Every failure leaves the API in the documented envelope, and nothing about
 * the internals leaves the process: stack traces, driver errors, file paths and
 * connection strings are logged server-side and replaced with a message written
 * for a person. That is not tidiness — a Mongoose `CastError` names the field
 * and collection, and a duplicate-key error prints the value that collided.
 */

interface Described {
  readonly statusCode: number;
  readonly body: ApiErrorBody;
  readonly logLevel: 'warn' | 'error';
}

/** MongoDB's duplicate-key error number. */
const DUPLICATE_KEY = 11000;

function fieldErrorsFrom(error: ZodError): readonly ApiFieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '_',
    message: issue.message,
  }));
}

function describe(error: unknown): Described {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      body: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
      // Expected, client-caused failures are not operational incidents and
      // must not page anyone.
      logLevel: error.statusCode >= 500 ? 'error' : 'warn',
    };
  }

  /*
   * A Zod error reaching here means a schema was parsed outside the validation
   * middleware — a service re-validating its own input, usually. It is still a
   * client-input problem, so it gets the same 400 and the same field list
   * rather than becoming a 500.
   */
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields need attention.',
        fields: fieldErrorsFrom(error),
      },
      logLevel: 'warn',
    };
  }

  /*
   * A duplicate key means a unique index did its job. Which index is not said:
   * the error carries the colliding value, and for `user.email` that would
   * confirm an address is registered.
   */
  if (error instanceof mongo.MongoServerError && error.code === DUPLICATE_KEY) {
    return {
      statusCode: 409,
      body: {
        code: 'CONFLICT',
        message: 'That conflicts with something that already exists.',
      },
      logLevel: 'warn',
    };
  }

  // A malformed ObjectId in a path. Repositories convert through `toObjectId`
  // and return null instead, so this is a backstop for a path that did not.
  if (error instanceof MongooseError.CastError) {
    return {
      statusCode: 400,
      body: { code: 'VALIDATION_ERROR', message: 'One of the identifiers is not valid.' },
      logLevel: 'warn',
    };
  }

  if (error instanceof MongooseError.ValidationError) {
    return {
      statusCode: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields need attention.',
        // Mongoose messages name the schema path, which is a field name the
        // client already knows. The message text itself is not forwarded.
        fields: Object.keys(error.errors).map((field) => ({
          field,
          message: 'This value is not valid.',
        })),
      },
      logLevel: 'warn',
    };
  }

  /*
   * `express.json()` rejects a malformed or oversized body with an HTTP-flavoured
   * error. Both are the client's doing, so neither should read as a server fault.
   */
  const status = readHttpStatus(error);
  if (status !== null && status >= 400 && status < 500) {
    const code = codeForStatus(status);
    return { statusCode: status, body: { code, message: messageForCode(code) }, logLevel: 'warn' };
  }

  return {
    statusCode: 500,
    body: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    logLevel: 'error',
  };
}

function readHttpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  return typeof value === 'number' ? value : null;
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  // Headers already sent means the failure happened mid-stream; only Express's
  // own handler can close the socket cleanly from here.
  if (response.headersSent) {
    next(error);
    return;
  }

  const { statusCode, body, logLevel } = describe(error);

  logger[logLevel](
    {
      requestId: request.id,
      method: request.method,
      path: request.originalUrl.split('?')[0] ?? request.originalUrl,
      status: statusCode,
      code: body.code,
      userId: request.auth?.user.id,
      organizationId: request.organization?.id,
      // The full error, stack included, is logged only server-side.
      err: error instanceof Error ? error : new Error(String(error)),
    },
    'request.failed',
  );

  ApiResponse.error(response, statusCode, body);
}
