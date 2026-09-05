import { describe, expect, it } from 'vitest';

import { API_ERROR_CODES } from '../contracts/index.js';

import { toApiError } from './auth.error-mapping.js';

describe('auth error mapping', () => {
  it('always produces a documented error code', () => {
    const codes = [
      'INVALID_EMAIL_OR_PASSWORD',
      'EMAIL_NOT_VERIFIED',
      'USER_ALREADY_EXISTS',
      'PASSWORD_TOO_SHORT',
      'INVALID_TOKEN',
      'TOKEN_EXPIRED',
      'SOMETHING_THE_LIBRARY_ADDED_LATER',
    ];

    for (const code of codes) {
      const result = toApiError(400, { code });
      expect(API_ERROR_CODES).toContain(result.error.code);
      expect(result.success).toBe(false);
    }
  });

  it('maps credential failures to one indistinguishable response', () => {
    // Sign-in must not reveal whether an address is registered, so a wrong
    // password and an unknown account have to be byte-identical.
    const wrongPassword = toApiError(401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
    const unknownAccount = toApiError(401, { code: 'USER_NOT_FOUND' });

    expect(wrongPassword).toEqual(unknownAccount);
    expect(wrongPassword.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('maps the codes the sign-up and reset flows actually return', () => {
    expect(toApiError(403, { code: 'EMAIL_NOT_VERIFIED' }).error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(toApiError(422, { code: 'USER_ALREADY_EXISTS' }).error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );
    expect(toApiError(400, { code: 'PASSWORD_TOO_SHORT' }).error.code).toBe('VALIDATION_ERROR');
    expect(toApiError(400, { code: 'INVALID_TOKEN' }).error.code).toBe('INVALID_TOKEN');
    expect(toApiError(400, { code: 'TOKEN_EXPIRED' }).error.code).toBe('TOKEN_EXPIRED');
  });

  it('falls back to the status when the library sends no code', () => {
    expect(toApiError(401, {}).error.code).toBe('UNAUTHENTICATED');
    expect(toApiError(403, {}).error.code).toBe('FORBIDDEN');
    expect(toApiError(429, {}).error.code).toBe('RATE_LIMITED');
    expect(toApiError(500, {}).error.code).toBe('INTERNAL_ERROR');
  });

  it('never leaks an internal message for an unmapped failure', () => {
    const result = toApiError(500, {
      code: 'DATABASE_CONNECTION_STRING_INVALID',
      message: 'mongodb://user:hunter2@cluster.internal:27017 refused the connection',
    });

    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).not.toContain('mongodb://');
    expect(result.error.message).not.toContain('hunter2');
  });

  it('ignores a non-string code rather than trusting it', () => {
    expect(toApiError(400, { code: 42 }).error.code).toBe('VALIDATION_ERROR');
    expect(toApiError(400, { code: null }).error.code).toBe('VALIDATION_ERROR');
  });
});
