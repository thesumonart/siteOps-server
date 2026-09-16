import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AnthropicModel } from './anthropic-model.js';
import { languageModelFrom } from './language-model-factory.js';
import { LanguageModelError } from './language-model.js';
import { OpenAiModel } from './openai-model.js';

interface Received {
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

let server: Server | null = null;

afterEach(async () => {
  const current = server;
  server = null;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

async function provider(
  answer: (received: Received, response: ServerResponse) => void,
): Promise<{ readonly baseUrl: string; readonly received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const entry = {
        path: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(raw) as Record<string, unknown>,
      };
      received.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(port)}`, received };
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

const REQUEST = { system: 'Be brief.', prompt: 'Summarise.', maxOutputTokens: 500 };

async function failure(promise: Promise<unknown>): Promise<LanguageModelError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LanguageModelError);
  return error as LanguageModelError;
}

describe('Anthropic', () => {
  it('sends a Messages API request and reads the text back', async () => {
    const { baseUrl, received } = await provider((_request, response) => {
      json(response, 200, {
        content: [
          { type: 'text', text: '## Summary\n' },
          { type: 'text', text: 'Down for five minutes.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 812, output_tokens: 64 },
      });
    });
    const model = new AnthropicModel({
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      timeoutMs: 5_000,
      baseUrl,
    });

    const completion = await model.complete(REQUEST);

    expect(completion).toEqual({
      text: '## Summary\nDown for five minutes.',
      truncated: false,
      inputTokens: 812,
      outputTokens: 64,
    });
    expect(received[0]?.path).toBe('/v1/messages');
    expect(received[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(received[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(received[0]?.body).toEqual({
      model: 'claude-opus-5',
      max_tokens: 500,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Summarise.' }],
    });
  });

  it('reports hitting the token limit', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(response, 200, {
        content: [{ type: 'text', text: 'Partial' }],
        stop_reason: 'max_tokens',
      });
    });
    const model = new AnthropicModel({ apiKey: 'k', model: 'm', timeoutMs: 5_000, baseUrl });
    expect((await model.complete(REQUEST)).truncated).toBe(true);
  });

  it('retries an overloaded provider, naming the error type but not its message', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(
        response,
        529,
        {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Account acme is over its limit' },
        },
        { 'retry-after': '30' },
      );
    });
    const model = new AnthropicModel({ apiKey: 'k', model: 'm', timeoutMs: 5_000, baseUrl });

    const error = await failure(model.complete(REQUEST));
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(529);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toBe('Anthropic answered HTTP 529 (overloaded_error).');
    expect(error.message).not.toContain('acme');
  });

  it('does not retry a request the provider will always refuse', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(response, 401, { type: 'error', error: { type: 'authentication_error' } });
    });
    const model = new AnthropicModel({ apiKey: 'bad', model: 'm', timeoutMs: 5_000, baseUrl });

    const error = await failure(model.complete(REQUEST));
    expect(error.retryable).toBe(false);
  });

  it('gives up on a provider that does not answer in time, and retries later', async () => {
    const { baseUrl } = await provider(() => {
      // Never answers.
    });
    const model = new AnthropicModel({ apiKey: 'k', model: 'm', timeoutMs: 200, baseUrl });

    const error = await failure(model.complete(REQUEST));
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/did not answer within/);
  });

  it('treats an answer with no text as a failure', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(response, 200, { content: [], stop_reason: 'end_turn' });
    });
    const model = new AnthropicModel({ apiKey: 'k', model: 'm', timeoutMs: 5_000, baseUrl });

    expect((await failure(model.complete(REQUEST))).retryable).toBe(true);
  });
});

describe('OpenAI', () => {
  it('sends a Chat Completions request and reads the text back', async () => {
    const { baseUrl, received } = await provider((_request, response) => {
      json(response, 200, {
        choices: [{ message: { content: '## Summary\nDown.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 700, completion_tokens: 40 },
      });
    });
    const model = new OpenAiModel({ apiKey: 'sk-test', model: 'gpt-5', timeoutMs: 5_000, baseUrl });

    const completion = await model.complete(REQUEST);

    expect(completion).toEqual({
      text: '## Summary\nDown.',
      truncated: false,
      inputTokens: 700,
      outputTokens: 40,
    });
    expect(received[0]?.path).toBe('/v1/chat/completions');
    expect(received[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(received[0]?.body).toEqual({
      model: 'gpt-5',
      max_completion_tokens: 500,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Summarise.' },
      ],
    });
  });

  it('reports hitting the token limit', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(response, 200, {
        choices: [{ message: { content: 'Partial' }, finish_reason: 'length' }],
      });
    });
    const model = new OpenAiModel({ apiKey: 'k', model: 'm', timeoutMs: 5_000, baseUrl });
    expect((await model.complete(REQUEST)).truncated).toBe(true);
  });

  it('retries a rate limit', async () => {
    const { baseUrl } = await provider((_request, response) => {
      json(response, 429, { error: { type: 'rate_limit_exceeded', message: 'Slow down' } });
    });
    const model = new OpenAiModel({ apiKey: 'k', model: 'm', timeoutMs: 5_000, baseUrl });

    const error = await failure(model.complete(REQUEST));
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('OpenAI answered HTTP 429 (rate_limit_exceeded).');
  });
});

describe('choosing a model', () => {
  const base = { AI_REQUEST_TIMEOUT_MS: 60_000 };

  it('is none without a key', () => {
    expect(languageModelFrom(base)).toBeNull();
  });

  it('uses whichever key is set, Anthropic first', () => {
    expect(languageModelFrom({ ...base, OPENAI_API_KEY: 'o' })?.provider).toBe('openai');
    expect(
      languageModelFrom({ ...base, OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })?.provider,
    ).toBe('anthropic');
  });

  it('follows AI_PROVIDER when both keys are set', () => {
    const model = languageModelFrom({
      ...base,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'o',
      ANTHROPIC_API_KEY: 'a',
    });
    expect(model?.provider).toBe('openai');
  });

  it('defaults each provider to its current model, and lets AI_MODEL override it', () => {
    expect(languageModelFrom({ ...base, ANTHROPIC_API_KEY: 'a' })?.model).toBe('claude-opus-5');
    expect(languageModelFrom({ ...base, OPENAI_API_KEY: 'o' })?.model).toBe('gpt-5');
    expect(languageModelFrom({ ...base, OPENAI_API_KEY: 'o', AI_MODEL: 'gpt-5-mini' })?.model).toBe(
      'gpt-5-mini',
    );
  });
});
