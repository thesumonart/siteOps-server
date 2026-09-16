import type { AiProvider } from '../contracts/index.js';
import { AnthropicModel, DEFAULT_ANTHROPIC_MODEL } from './anthropic-model.js';
import type { LanguageModel } from './language-model.js';
import { DEFAULT_OPENAI_MODEL, OpenAiModel } from './openai-model.js';

export interface LanguageModelSettings {
  readonly AI_PROVIDER?: AiProvider | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly AI_MODEL?: string | undefined;
  readonly AI_REQUEST_TIMEOUT_MS: number;
}

/**
 * The configured model, or null when this deployment has none.
 *
 * Null is a supported state, like a deployment without Stripe: nothing is
 * queued, nothing is sent anywhere, and the API says the feature is not
 * configured rather than pretending. There is no stub model.
 *
 * The provider is `AI_PROVIDER` when given — the environment schema has
 * already refused it without its key — and otherwise whichever key is set,
 * Anthropic first.
 */
export function languageModelFrom(settings: LanguageModelSettings): LanguageModel | null {
  const provider =
    settings.AI_PROVIDER ??
    (settings.ANTHROPIC_API_KEY ? 'anthropic' : settings.OPENAI_API_KEY ? 'openai' : null);

  if (provider === 'anthropic' && settings.ANTHROPIC_API_KEY) {
    return new AnthropicModel({
      apiKey: settings.ANTHROPIC_API_KEY,
      model: settings.AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
    });
  }

  if (provider === 'openai' && settings.OPENAI_API_KEY) {
    return new OpenAiModel({
      apiKey: settings.OPENAI_API_KEY,
      model: settings.AI_MODEL ?? DEFAULT_OPENAI_MODEL,
      timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
    });
  }

  return null;
}
