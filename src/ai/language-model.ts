import type { AiProvider } from '../contracts/index.js';

export interface CompletionRequest {
  /** Standing instructions: role, rules, output format. */
  readonly system: string;
  /** The one user turn: the task and its data. */
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

export interface Completion {
  readonly text: string;
  /** True when the model stopped because it hit `maxOutputTokens`. */
  readonly truncated: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * A text-generation provider.
 *
 * Deliberately one method. SiteOps asks a model for one thing — a written
 * summary from structured facts — so the interface is that request and nothing
 * a provider SDK would add. Both adapters call the provider's REST API with
 * `undici`, for the reason the Stripe and PageSpeed clients do: a few lines of
 * request code are a smaller surface than a dependency that ships the rest of
 * the API with it.
 */
export interface LanguageModel {
  readonly provider: AiProvider;
  readonly model: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

/**
 * A generation that did not produce text.
 *
 * `message` is written to be stored and shown to the organization — "Anthropic
 * answered HTTP 529 (overloaded_error)" — so it names the provider's status and
 * error type and never repeats the provider's free-text message, which is
 * written for the account holder and can describe the account.
 */
export class LanguageModelError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      readonly retryable: boolean;
      readonly statusCode?: number | null;
      readonly retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = 'LanguageModelError';
    this.retryable = options.retryable;
    this.statusCode = options.statusCode ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}
