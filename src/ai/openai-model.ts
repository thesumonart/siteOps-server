import type { Completion, CompletionRequest, LanguageModel } from './language-model.js';
import { LanguageModelError } from './language-model.js';
import { postToProvider } from './provider-http.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

export interface OpenAiModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Overridden only by tests, which point it at a local server. */
  readonly baseUrl?: string;
}

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** OpenAI, through the Chat Completions API. */
export class OpenAiModel implements LanguageModel {
  readonly provider = 'openai';
  readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: OpenAiModelOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com';
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const response = await postToProvider(
      'OpenAI',
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        // `max_completion_tokens`, not `max_tokens`: reasoning models refuse the
        // older name, and every current model accepts this one.
        max_completion_tokens: request.maxOutputTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
      },
      this.timeoutMs,
    );

    const body = response.body as ChatCompletionResponse;
    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? '';

    if (text.trim().length === 0) {
      throw new LanguageModelError('OpenAI answered without any text.', { retryable: true });
    }

    return {
      text,
      truncated: choice?.finish_reason === 'length',
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    };
  }
}
