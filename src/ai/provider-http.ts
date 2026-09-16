import { request } from 'undici';

import { parseRetryAfter } from '../integrations/channel-sender.js';
import { createLogger } from '../utils/logger.js';
import { LanguageModelError } from './language-model.js';

const logger = createLogger('ai');

export interface ProviderResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

/**
 * Statuses worth trying again: the provider is busy, rate limiting, or broken
 * for now. Anything else in the 4xx range — a bad key, an unknown model, a
 * request it refuses — will fail identically next time, and retrying it only
 * spends attempts and delays the "failed" a person needs to see.
 */
function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

/**
 * POSTs JSON to a model provider and returns the parsed JSON of a 2xx answer.
 *
 * Every failure becomes a {@link LanguageModelError}. The provider's error body
 * is logged, truncated, for the operator; what is thrown carries only the
 * status and the provider's machine-readable error type, because it is stored
 * on the incident and shown to the organization.
 */
export async function postToProvider(
  providerLabel: string,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let statusCode: number;
  let text: string;
  let retryAfter: string | string[] | undefined;

  try {
    const response = await request(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    statusCode = response.statusCode;
    retryAfter = response.headers['retry-after'];
    text = await response.body.text();
  } catch (error) {
    const timedOut = controller.signal.aborted;
    logger.warn({ provider: providerLabel, err: error, timedOut }, 'ai.provider_unreachable');
    throw new LanguageModelError(
      timedOut
        ? `${providerLabel} did not answer within ${String(Math.round(timeoutMs / 1000))} seconds.`
        : `${providerLabel} could not be reached.`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  const body = parseJson(text);

  if (statusCode < 200 || statusCode >= 300) {
    logger.warn(
      { provider: providerLabel, status: statusCode, body: text.slice(0, 1000) },
      'ai.provider_error',
    );
    const errorType = providerErrorType(body);
    throw new LanguageModelError(
      `${providerLabel} answered HTTP ${String(statusCode)}${errorType ? ` (${errorType})` : ''}.`,
      {
        retryable: isRetryableStatus(statusCode),
        statusCode,
        retryAfterSeconds: parseRetryAfter(retryAfter),
      },
    );
  }

  if (body === undefined) {
    throw new LanguageModelError(`${providerLabel} answered with something that is not JSON.`, {
      retryable: true,
      statusCode,
    });
  }

  return { statusCode, body };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The provider's machine-readable error type, if the body carries one.
 *
 * Both providers nest it under `error.type`. Restricted to a short identifier so
 * nothing resembling prose — or an account detail — is ever stored from it.
 */
function providerErrorType(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const type = (error as { type?: unknown }).type;
  return typeof type === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(type) ? type : null;
}
