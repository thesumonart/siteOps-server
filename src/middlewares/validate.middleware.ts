import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import type { ApiFieldError } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';

/**
 * Validates a request against Zod schemas and replaces the raw input with the
 * parsed result.
 *
 * The schemas come from `src/contracts/schemas`, which the dashboard imports
 * too — so the browser form and the API enforce literally the same rule, and a
 * URL normalized by `websiteUrlSchema` arrives here already canonical. Running
 * a second, server-only validation system is how the two drift apart until a
 * form starts accepting input that fails on submit.
 *
 * Parsed values are written to `request.validated` rather than over
 * `request.body`/`request.query`, because Express 5 makes `query` a getter with
 * no setter. Handlers read them through the accessors below, which throw if the
 * middleware was not wired up — a missing schema then fails loudly at the first
 * request instead of silently handing a controller unvalidated input.
 */

export interface ValidationSchemas {
  readonly body?: ZodType;
  readonly query?: ZodType;
  readonly params?: ZodType;
}

function toFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  prefix: string,
): ApiFieldError[] {
  return issues.map((issue) => ({
    // The prefix is dropped for a body field so the name matches the form
    // control the dashboard maps it onto; a query or param error keeps it,
    // because there is no form field to blame.
    field:
      prefix === 'body'
        ? issue.path.map(String).join('.') || '_'
        : [prefix, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const fields: ApiFieldError[] = [];
    const validated: NonNullable<Request['validated']> = {};

    if (schemas.body) {
      const result = schemas.body.safeParse(request.body);
      if (result.success) validated.body = result.data;
      else fields.push(...toFieldErrors(result.error.issues, 'body'));
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(request.query);
      if (result.success) validated.query = result.data;
      else fields.push(...toFieldErrors(result.error.issues, 'query'));
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(request.params);
      if (result.success) validated.params = result.data;
      else fields.push(...toFieldErrors(result.error.issues, 'params'));
    }

    if (fields.length > 0) {
      next(ApiError.validation('Some fields need attention.', fields));
      return;
    }

    request.validated = validated;
    next();
  };
}

function read<T>(value: unknown, part: string): T {
  if (value === undefined) {
    // A wiring bug, not a client error: the route forgot its schema.
    throw new Error(`Route read validated ${part} without a ${part} schema.`);
  }
  return value as T;
}

export function validatedBody<T>(request: Request): T {
  return read<T>(request.validated?.body, 'body');
}

export function validatedQuery<T>(request: Request): T {
  return read<T>(request.validated?.query, 'query');
}

export function validatedParams<T>(request: Request): T {
  return read<T>(request.validated?.params, 'params');
}
