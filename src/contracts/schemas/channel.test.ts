import { describe, expect, it } from 'vitest';

import { CHANNEL_EVENTS } from '../domain/channel.js';
import { createChannelSchema, updateChannelSchema, validateChannelUrl } from './channel.js';

const SLACK_URL = 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop';
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl';

describe('Slack channel URLs', () => {
  it('accepts an incoming webhook URL', () => {
    expect(validateChannelUrl('slack', SLACK_URL)).toEqual({ ok: true, href: SLACK_URL });
  });

  it.each([
    ['plain http', 'http://hooks.slack.com/services/T0000/B0000/abc'],
    ['another host', 'https://hooks.slack.com.attacker.example.org/services/T/B/abc'],
    ['another path on Slack', 'https://hooks.slack.com/api/chat.postMessage'],
    ['credentials', 'https://user:pass@hooks.slack.com/services/T/B/abc'],
    ['a custom port', 'https://hooks.slack.com:8443/services/T/B/abc'],
    ['a Discord URL', DISCORD_URL],
  ])('refuses %s', (_label, url) => {
    expect(validateChannelUrl('slack', url).ok).toBe(false);
  });
});

describe('Discord channel URLs', () => {
  it.each([
    DISCORD_URL,
    'https://discordapp.com/api/webhooks/123/abc',
    'https://discord.com/api/v10/webhooks/123/abc',
  ])('accepts %s', (url) => {
    expect(validateChannelUrl('discord', url).ok).toBe(true);
  });

  it.each([
    ['plain http', 'http://discord.com/api/webhooks/123/abc'],
    ['a lookalike host', 'https://discord.com.example.org/api/webhooks/123/abc'],
    ['a non-webhook path', 'https://discord.com/api/channels/123/messages'],
    ['a Slack URL', SLACK_URL],
  ])('refuses %s', (_label, url) => {
    expect(validateChannelUrl('discord', url).ok).toBe(false);
  });
});

describe('webhook channel URLs', () => {
  it('accepts a public https endpoint and canonicalizes it', () => {
    expect(validateChannelUrl('webhook', 'https://Hooks.Example.org/in?token=abc#frag')).toEqual({
      ok: true,
      href: 'https://hooks.example.org/in?token=abc',
    });
  });

  it.each([
    ['plain http', 'http://hooks.example.org/in'],
    ['loopback', 'https://127.0.0.1/in'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['a private range', 'https://10.0.0.5/in'],
    ['an internal name', 'https://jenkins.internal/hook'],
    ['localhost', 'https://localhost/hook'],
    ['credentials', 'https://user:pass@hooks.example.org/in'],
    ['another scheme', 'ftp://hooks.example.org/in'],
  ])('refuses %s', (_label, url) => {
    expect(validateChannelUrl('webhook', url).ok).toBe(false);
  });
});

describe('creating a channel', () => {
  it('subscribes to every event and starts enabled unless told otherwise', () => {
    const parsed = createChannelSchema.parse({ name: 'On-call', type: 'slack', url: SLACK_URL });

    expect(parsed.events).toEqual([...CHANNEL_EVENTS]);
    expect(parsed.enabled).toBe(true);
  });

  it('keeps metadata for a webhook and drops it for Slack, which has nowhere to put it', () => {
    const webhook = createChannelSchema.parse({
      name: 'Pager',
      type: 'webhook',
      url: 'https://hooks.example.org/in',
      metadata: { environment: 'production' },
    });
    const slack = createChannelSchema.parse({
      name: 'On-call',
      type: 'slack',
      url: SLACK_URL,
      metadata: { environment: 'production' },
    });

    expect(webhook).toMatchObject({ metadata: { environment: 'production' } });
    expect(slack).not.toHaveProperty('metadata');
  });

  it('collapses a repeated event rather than refusing it', () => {
    const parsed = createChannelSchema.parse({
      name: 'On-call',
      type: 'slack',
      url: SLACK_URL,
      events: ['website.down', 'website.down'],
    });
    expect(parsed.events).toEqual(['website.down']);
  });

  it('refuses a channel that hears about nothing', () => {
    const result = createChannelSchema.safeParse({
      name: 'On-call',
      type: 'slack',
      url: SLACK_URL,
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it('bounds metadata, since it is copied into every delivery', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 11 }, (_unused, index) => [`key${String(index)}`, 'value']),
    );

    for (const metadata of [tooMany, { 'has space': 'x' }, { key: 'x'.repeat(201) }]) {
      const result = createChannelSchema.safeParse({
        name: 'Pager',
        type: 'webhook',
        url: 'https://hooks.example.org/in',
        metadata,
      });
      expect(result.success).toBe(false);
    }
  });

  it('refuses an unknown channel type', () => {
    const result = createChannelSchema.safeParse({
      name: 'Pager',
      type: 'sms',
      url: 'https://hooks.example.org/in',
    });
    expect(result.success).toBe(false);
  });
});

describe('editing a channel', () => {
  it('accepts an empty patch, which changes nothing', () => {
    expect(updateChannelSchema.parse({})).toEqual({});
  });

  it('does not let the type be changed', () => {
    // Unknown keys are stripped: a type in the body is ignored, not applied.
    expect(updateChannelSchema.parse({ type: 'webhook' })).toEqual({});
  });
});
