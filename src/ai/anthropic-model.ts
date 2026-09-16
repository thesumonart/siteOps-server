import type { Completion, CompletionRequest, LanguageModel } from './language-model.js';
import { LanguageModelError } from './language-model.js';
import { postToProvider } from './provider-http.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Pinned so a change on Anthropic's side cannot alter these payloads unannounced. */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Overridden only by tests, which point it at a local server. */
  readonly baseUrl?: string;
}

interface MessagesResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string | null;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/** Claude, through the Messages API. */
export class AnthropicModel implements LanguageModel {
  readonly provider = 'anthropic';
  readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: AnthropicModelOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const response = await postToProvider(
      'Anthropic',
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      {
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      },
      this.timeoutMs,
    );

    const body = response.body as MessagesResponse;
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    if (text.trim().length === 0) {
      throw new LanguageModelError('Anthropic answered without any text.', { retryable: true });
    }

    return {
      text,
      truncated: body.stop_reason === 'max_tokens',
      inputTokens: body.usage?.input_tokens ?? null,
      outputTokens: body.usage?.output_tokens ?? null,
    };
  }
}
