import { describe, expect, it } from 'vitest';

import type { ChannelEventPayload, WebhookEventType } from '../contracts/index.js';
import {
  describeEvent,
  renderChannelBody,
  renderDiscordMessage,
  renderSlackMessage,
} from './channel-formatters.js';

const STARTED_AT = '2026-09-10T08:00:00.000Z';
const RESOLVED_AT = '2026-09-10T08:04:12.000Z';

function payload(
  type: WebhookEventType,
  data: Partial<ChannelEventPayload['data']> = {},
): ChannelEventPayload {
  return {
    id: `${type}:incident-1`,
    type,
    createdAt: STARTED_AT,
    organizationId: 'org-1',
    data: {
      website: { id: 'site-1', name: 'Acme Store', url: 'https://acme.example.org/' },
      incident: {
        id: 'incident-1',
        status: 'open',
        type: 'http_error',
        category: 'availability',
        severity: 'critical',
        detail: null,
        startedAt: STARTED_AT,
        resolvedAt: null,
        durationSeconds: null,
        failedCheckCount: 3,
        lastStatusCode: 503,
        lastErrorType: 'http_error',
        lastErrorMessage: 'Responded with HTTP 503.',
      },
      monitor: null,
      anomaly: null,
      dashboardUrl: 'https://app.siteops.test/dashboard/websites/site-1',
      ...data,
    },
  };
}

describe('describing an event', () => {
  it('says what went down, how, and since when', () => {
    const message = describeEvent(payload('website.down'));

    expect(message.tone).toBe('critical');
    expect(message.title).toContain('Acme Store is down');
    expect(message.summary).toBe(
      'Acme Store stopped responding after 3 consecutive failed checks.',
    );
    expect(message.facts).toEqual([
      { label: 'Status code', value: '503' },
      { label: 'Error', value: 'Unsuccessful HTTP status' },
      { label: 'Failed checks', value: '3' },
      { label: 'Down since', value: new Date(STARTED_AT) },
    ]);
    expect(message.link.url).toBe('https://app.siteops.test/dashboard/websites/site-1');
  });

  it('reports a recovery with its downtime, in green', () => {
    const recovered = payload('website.recovered');
    const message = describeEvent({
      ...recovered,
      data: {
        ...recovered.data,
        incident: recovered.data.incident && {
          ...recovered.data.incident,
          status: 'resolved',
          resolvedAt: RESOLVED_AT,
          durationSeconds: 252,
        },
      },
    });

    expect(message.tone).toBe('success');
    expect(message.summary).toBe('Acme Store is responding again after 4m 12s down.');
    expect(message.facts[0]).toEqual({ label: 'Downtime', value: '4m 12s' });
  });

  it('grades a monitor problem by how bad it is', () => {
    const failing = describeEvent(
      payload('monitor.problem', {
        monitor: { type: 'ssl', status: 'failing', summary: 'Certificate expired 2 days ago' },
      }),
    );
    const warning = describeEvent(
      payload('monitor.problem', {
        monitor: { type: 'ssl', status: 'warning', summary: 'Certificate expires in 6 days' },
      }),
    );

    expect(failing.tone).toBe('critical');
    expect(warning.tone).toBe('warning');
    expect(warning.title).toContain('SSL certificate problem on Acme Store');
    expect(warning.summary).toBe('Certificate expires in 6 days');
  });

  it('explains a slowdown with the numbers behind it, as a warning rather than an outage', () => {
    const message = describeEvent(
      payload('website.degraded', {
        anomaly: {
          responseTimeMs: 1840,
          baselineMeanMs: 310,
          baselineStdDevMs: 45,
          sampleCount: 100,
          zScore: 34,
        },
      }),
    );

    expect(message.tone).toBe('warning');
    expect(message.title).toContain('Acme Store is responding slowly');
    expect(message.facts.slice(0, 3)).toEqual([
      { label: 'Response time', value: '1840 ms' },
      { label: 'Usual', value: '310 ms ± 45' },
      { label: 'Deviation', value: '34.0σ' },
    ]);
  });

  it('reports the end of a slowdown with how long it lasted', () => {
    const resolved = payload('website.degradation_resolved');
    const message = describeEvent({
      ...resolved,
      data: {
        ...resolved.data,
        incident: resolved.data.incident && {
          ...resolved.data.incident,
          status: 'resolved',
          resolvedAt: RESOLVED_AT,
          durationSeconds: 252,
        },
      },
    });

    expect(message.tone).toBe('success');
    expect(message.summary).toBe('Response times on Acme Store are back to normal after 4m 12s.');
  });

  it('describes a test message without inventing a website', () => {
    const message = describeEvent(
      payload('channel.test', { website: null, incident: null, dashboardUrl: 'https://x.test/' }),
    );

    expect(message.website).toBeNull();
    expect(message.facts).toEqual([]);
    expect(message.title).toContain('SiteOps is connected');
  });
});

describe('Slack', () => {
  it('renders Block Kit inside a coloured attachment, with a readable fallback', () => {
    const body = renderSlackMessage(describeEvent(payload('website.down'))) as {
      text: string;
      attachments: { color: string; blocks: { type: string; [key: string]: unknown }[] }[];
    };

    expect(body.text).toContain('Acme Store is down');
    const [attachment] = body.attachments;
    expect(attachment?.color).toBe('#DC2626');
    expect(attachment?.blocks.map((block) => block.type)).toEqual([
      'header',
      'section',
      'section',
      'actions',
    ]);
  });

  it('shows dates in the reader own timezone', () => {
    const body = JSON.stringify(renderSlackMessage(describeEvent(payload('website.down'))));
    const unix = String(Math.floor(new Date(STARTED_AT).getTime() / 1000));
    expect(body).toContain(`<!date^${unix}^{date_short_pretty} at {time}|${STARTED_AT}>`);
  });

  it('escapes what a customer typed, so a website name cannot ping the channel', () => {
    const body = renderSlackMessage(
      describeEvent(
        payload('website.down', {
          website: { id: 's', name: '<!channel> Acme & Co', url: 'https://acme.example.org/' },
        }),
      ),
    ) as {
      text: string;
      attachments: { blocks: { type: string; text?: { type: string; text: string } }[] }[];
    };
    const [header, section] = body.attachments[0]?.blocks ?? [];

    // Every field Slack parses as mrkdwn — where `<!channel>` would notify
    // everyone — is escaped: the notification text and the section.
    expect(body.text).toContain('&lt;!channel&gt; Acme &amp; Co');
    expect(body.text).not.toContain('<!channel>');
    expect(section?.text?.text).toContain('&lt;!channel&gt; Acme &amp; Co');

    // The header is plain_text, which Slack never parses for mentions, so it
    // shows the name as typed rather than as `&lt;` noise.
    expect(header?.text).toEqual({
      type: 'plain_text',
      text: '🔴 <!channel> Acme & Co is down',
      emoji: true,
    });
  });

  it('marks the button dangerous only for a critical alert', () => {
    const down = JSON.stringify(renderSlackMessage(describeEvent(payload('website.down'))));
    const test = JSON.stringify(
      renderSlackMessage(describeEvent(payload('channel.test', { website: null }))),
    );

    expect(down).toContain('"style":"danger"');
    expect(test).not.toContain('"style"');
  });

  it('stays within the header limit Slack enforces', () => {
    const longName = 'A'.repeat(400);
    const body = renderSlackMessage(
      describeEvent(
        payload('website.down', {
          website: { id: 's', name: longName, url: 'https://acme.example.org/' },
        }),
      ),
    ) as { attachments: { blocks: { text?: { text: string } }[] }[] };

    const header = body.attachments[0]?.blocks[0]?.text?.text ?? '';
    expect(header.length).toBeLessThanOrEqual(150);
    expect(header.endsWith('…')).toBe(true);
  });
});

describe('Discord', () => {
  it('renders an embed that can never mention anyone', () => {
    const body = renderDiscordMessage(describeEvent(payload('website.down')), STARTED_AT) as {
      allowed_mentions: { parse: unknown[] };
      embeds: { color: number; fields: { inline: boolean }[]; timestamp: string }[];
    };

    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]?.color).toBe(0xdc2626);
    expect(body.embeds[0]?.timestamp).toBe(STARTED_AT);
    expect(body.embeds[0]?.fields.every((field) => field.inline)).toBe(true);
  });

  it('escapes markdown in what a customer typed', () => {
    const body = JSON.stringify(
      renderDiscordMessage(
        describeEvent(
          payload('website.down', {
            website: { id: 's', name: 'Acme *Staging*', url: 'https://acme.example.org/' },
          }),
        ),
        STARTED_AT,
      ),
    );

    // JSON doubles the backslash; the rendered text is `Acme \*Staging\*`.
    expect(body).toContain('Acme \\\\*Staging\\\\*');
  });

  it('uses Discord timestamps, which render in the reader own timezone', () => {
    const body = JSON.stringify(
      renderDiscordMessage(describeEvent(payload('website.down')), STARTED_AT),
    );
    expect(body).toContain(`<t:${String(Math.floor(new Date(STARTED_AT).getTime() / 1000))}:f>`);
  });
});

describe('webhooks', () => {
  it('receive the payload itself, plus their own metadata, and no prose', () => {
    const event = payload('website.down');
    const body = renderChannelBody('webhook', event, { environment: 'production' });

    expect(body).toEqual({ ...event, metadata: { environment: 'production' } });
  });
});
