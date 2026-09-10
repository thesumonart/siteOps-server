import {
  CHECK_ERROR_LABELS,
  MONITOR_STATUS_LABELS,
  MONITOR_TYPE_LABELS,
  formatDuration,
  type ChannelEventPayload,
  type ChannelType,
  type WebhookBody,
} from '../contracts/index.js';

/**
 * Turns one event into the body each kind of channel expects.
 *
 * Two steps, deliberately. `describeEvent` first reduces the payload to a
 * platform-neutral message — a title, a sentence, a few facts, a link and a
 * tone — and only then does a renderer map that onto Slack Block Kit or a
 * Discord embed. The wording of an outage alert is therefore decided once, and
 * Slack and Discord cannot describe the same outage differently.
 *
 * A webhook gets no description at all. Its body is the payload itself, for a
 * program to read; prose there would be one more thing a receiver could come to
 * depend on the exact wording of.
 *
 * Everything that reaches a chat message from a customer — a website name, an
 * error string from somebody's server — is escaped for the platform. A website
 * named `<!channel>` must not page a whole Slack workspace.
 */

export type MessageTone = 'critical' | 'warning' | 'success' | 'info';

/** A fact row. A date is kept as a date so each platform can localize it for the reader. */
export interface MessageFact {
  readonly label: string;
  readonly value: string | Date;
}

export interface ChannelMessage {
  readonly title: string;
  readonly summary: string;
  readonly tone: MessageTone;
  readonly facts: readonly MessageFact[];
  readonly website: { readonly name: string; readonly url: string } | null;
  readonly link: { readonly label: string; readonly url: string };
}

/** Tailwind's 600 shades — the same red, amber and green the dashboard's status badges use. */
const TONE_COLORS: Record<MessageTone, string> = {
  critical: '#DC2626',
  warning: '#D97706',
  success: '#16A34A',
  info: '#2563EB',
};

const TONE_EMOJI: Record<MessageTone, string> = {
  critical: '🔴',
  warning: '🟠',
  success: '🟢',
  info: '✅',
};

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function milliseconds(value: number): string {
  return `${String(Math.round(value))} ms`;
}

function toDate(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso);
}

/** Reduces an event to what a person needs to read about it. */
export function describeEvent(payload: ChannelEventPayload): ChannelMessage {
  const { website, incident, monitor, anomaly, dashboardUrl } = payload.data;
  const name = website?.name ?? 'A website';
  const viewIncident = { label: 'View incident', url: dashboardUrl };

  switch (payload.type) {
    case 'website.down': {
      const failedChecks = incident?.failedCheckCount ?? 0;
      const facts: MessageFact[] = [];
      if (incident?.lastStatusCode != null) {
        facts.push({ label: 'Status code', value: String(incident.lastStatusCode) });
      }
      if (incident?.lastErrorType) {
        facts.push({ label: 'Error', value: CHECK_ERROR_LABELS[incident.lastErrorType] });
      }
      facts.push({ label: 'Failed checks', value: String(failedChecks) });
      const startedAt = toDate(incident?.startedAt ?? null);
      if (startedAt) facts.push({ label: 'Down since', value: startedAt });

      return {
        title: `${TONE_EMOJI.critical} ${name} is down`,
        summary: `${name} stopped responding after ${plural(failedChecks, 'consecutive failed check')}.`,
        tone: 'critical',
        facts,
        website,
        link: viewIncident,
      };
    }

    case 'website.recovered': {
      const duration = incident?.durationSeconds ?? null;
      const facts: MessageFact[] = [];
      if (duration !== null) facts.push({ label: 'Downtime', value: formatDuration(duration) });
      const startedAt = toDate(incident?.startedAt ?? null);
      if (startedAt) facts.push({ label: 'Went down', value: startedAt });
      const resolvedAt = toDate(incident?.resolvedAt ?? null);
      if (resolvedAt) facts.push({ label: 'Recovered', value: resolvedAt });

      return {
        title: `${TONE_EMOJI.success} ${name} is back up`,
        summary:
          duration === null
            ? `${name} is responding again.`
            : `${name} is responding again after ${formatDuration(duration)} down.`,
        tone: 'success',
        facts,
        website,
        link: viewIncident,
      };
    }

    case 'website.degraded': {
      const facts: MessageFact[] = [];
      if (anomaly) {
        facts.push({ label: 'Response time', value: milliseconds(anomaly.responseTimeMs) });
        facts.push({
          label: 'Usual',
          value: `${milliseconds(anomaly.baselineMeanMs)} ± ${String(anomaly.baselineStdDevMs)}`,
        });
        facts.push({ label: 'Deviation', value: `${anomaly.zScore.toFixed(1)}σ` });
      }
      const startedAt = toDate(incident?.startedAt ?? null);
      if (startedAt) facts.push({ label: 'Slow since', value: startedAt });

      return {
        title: `${TONE_EMOJI.warning} ${name} is responding slowly`,
        summary: incident?.detail ?? `${name} is answering far more slowly than usual.`,
        tone: 'warning',
        facts,
        website,
        link: { label: 'View website', url: dashboardUrl },
      };
    }

    case 'website.degradation_resolved': {
      const duration = incident?.durationSeconds ?? null;
      const facts: MessageFact[] = [];
      if (duration !== null) facts.push({ label: 'Slow for', value: formatDuration(duration) });
      const resolvedAt = toDate(incident?.resolvedAt ?? null);
      if (resolvedAt) facts.push({ label: 'Back to normal', value: resolvedAt });

      return {
        title: `${TONE_EMOJI.success} ${name} is back to its usual speed`,
        summary:
          duration === null
            ? `Response times on ${name} are back to normal.`
            : `Response times on ${name} are back to normal after ${formatDuration(duration)}.`,
        tone: 'success',
        facts,
        website,
        link: { label: 'View website', url: dashboardUrl },
      };
    }

    case 'monitor.problem': {
      const tone: MessageTone = monitor?.status === 'failing' ? 'critical' : 'warning';
      const label = monitor ? MONITOR_TYPE_LABELS[monitor.type] : 'Monitor';
      const facts: MessageFact[] = [{ label: 'Monitor', value: label }];
      if (monitor) facts.push({ label: 'Status', value: MONITOR_STATUS_LABELS[monitor.status] });
      const startedAt = toDate(incident?.startedAt ?? null);
      if (startedAt) facts.push({ label: 'Detected', value: startedAt });

      return {
        title: `${TONE_EMOJI[tone]} ${label} problem on ${name}`,
        summary: monitor?.summary ?? incident?.detail ?? `${label} reported a problem.`,
        tone,
        facts,
        website,
        link: viewIncident,
      };
    }

    case 'monitor.recovered': {
      const label = monitor ? MONITOR_TYPE_LABELS[monitor.type] : 'Monitor';
      const facts: MessageFact[] = [{ label: 'Monitor', value: label }];
      const duration = incident?.durationSeconds ?? null;
      if (duration !== null) facts.push({ label: 'Open for', value: formatDuration(duration) });
      const resolvedAt = toDate(incident?.resolvedAt ?? null);
      if (resolvedAt) facts.push({ label: 'Resolved', value: resolvedAt });

      return {
        title: `${TONE_EMOJI.success} ${label} resolved on ${name}`,
        summary: monitor?.summary ?? `${label} is passing again.`,
        tone: 'success',
        facts,
        website,
        link: viewIncident,
      };
    }

    case 'channel.test':
      return {
        title: `${TONE_EMOJI.info} SiteOps is connected`,
        summary:
          'This is a test message. Alerts for the events this channel subscribes to will arrive here.',
        tone: 'info',
        facts: [],
        website: null,
        link: { label: 'Open SiteOps', url: dashboardUrl },
      };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/* ------------------------------------------------------------------- Slack */

/**
 * Slack's mrkdwn treats `&`, `<` and `>` as control characters — `<!channel>`
 * notifies everyone in it — and those three are the whole of its escaping.
 */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A URL inside `<url|label>` may not contain the delimiters themselves. */
function slackUrl(url: string): string {
  return url.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E');
}

/** Slack renders this in each reader's own timezone; the ISO string is the fallback. */
function slackDate(date: Date): string {
  return `<!date^${String(unixSeconds(date))}^{date_short_pretty} at {time}|${date.toISOString()}>`;
}

/*
 * Slack's limits, from the Block Kit reference. Exceeding one rejects the whole
 * message with a 400, so each is enforced here rather than trusted to the data.
 */
const SLACK_HEADER_MAX = 150;
const SLACK_TEXT_MAX = 3000;
const SLACK_FIELD_MAX = 2000;
const SLACK_FIELDS_MAX = 10;

export function renderSlackMessage(message: ChannelMessage): Record<string, unknown> {
  const summary = message.website
    ? `${escapeSlack(message.summary)}\n<${slackUrl(message.website.url)}|${escapeSlack(message.website.url)}>`
    : escapeSlack(message.summary);

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(message.title, SLACK_HEADER_MAX), emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(summary, SLACK_TEXT_MAX) } },
  ];

  if (message.facts.length > 0) {
    blocks.push({
      type: 'section',
      fields: message.facts.slice(0, SLACK_FIELDS_MAX).map((fact) => ({
        type: 'mrkdwn',
        text: truncate(
          `*${escapeSlack(fact.label)}*\n${
            fact.value instanceof Date ? slackDate(fact.value) : escapeSlack(fact.value)
          }`,
          SLACK_FIELD_MAX,
        ),
      })),
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: message.link.label },
        url: message.link.url,
        ...(message.tone === 'critical' ? { style: 'danger' } : {}),
      },
    ],
  });

  return {
    // Top-level text is what a phone notification and a screen reader get. It
    // is parsed as mrkdwn, so it is escaped like every other mrkdwn field. The
    // header block is `plain_text`, which Slack never parses for mentions, so
    // the name is shown there exactly as it was typed.
    text: truncate(escapeSlack(`${message.title} — ${message.summary}`), SLACK_TEXT_MAX),
    // Blocks inside an attachment, so the message carries the coloured edge
    // that makes red and green legible at a glance in a busy channel.
    attachments: [{ color: TONE_COLORS[message.tone], blocks }],
  };
}

/* ----------------------------------------------------------------- Discord */

/** Backslash-escapes Discord's markdown so a website name renders as written. */
function escapeDiscord(text: string): string {
  return text.replace(/([\\*_~`|>[\]()])/g, '\\$1');
}

/** Discord renders `<t:…:f>` in each reader's own timezone. */
function discordDate(date: Date): string {
  return `<t:${String(unixSeconds(date))}:f>`;
}

// Discord's embed limits. Exceeding one rejects the whole message.
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_FIELDS_MAX = 25;

export function renderDiscordMessage(
  message: ChannelMessage,
  createdAt: string,
): Record<string, unknown> {
  const description = message.website
    ? `${escapeDiscord(message.summary)}\n${escapeDiscord(message.website.url)}`
    : escapeDiscord(message.summary);

  return {
    username: 'SiteOps',
    // Nothing a customer typed may ping @everyone, a role or a person.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(message.title, DISCORD_TITLE_MAX),
        url: message.link.url,
        description: truncate(description, DISCORD_DESCRIPTION_MAX),
        color: Number.parseInt(TONE_COLORS[message.tone].slice(1), 16),
        fields: message.facts.slice(0, DISCORD_FIELDS_MAX).map((fact) => ({
          name: truncate(fact.label, DISCORD_FIELD_NAME_MAX),
          value: truncate(
            fact.value instanceof Date ? discordDate(fact.value) : escapeDiscord(fact.value),
            DISCORD_FIELD_VALUE_MAX,
          ),
          inline: true,
        })),
        timestamp: createdAt,
        footer: { text: 'SiteOps' },
      },
    ],
  };
}

/* ----------------------------------------------------------------- webhook */

export function renderWebhookBody(
  payload: ChannelEventPayload,
  metadata: Readonly<Record<string, string>>,
): WebhookBody {
  return { ...payload, metadata };
}

/** The JSON body for one channel type. */
export function renderChannelBody(
  type: ChannelType,
  payload: ChannelEventPayload,
  metadata: Readonly<Record<string, string>>,
): unknown {
  switch (type) {
    case 'webhook':
      return renderWebhookBody(payload, metadata);
    case 'slack':
      return renderSlackMessage(describeEvent(payload));
    case 'discord':
      return renderDiscordMessage(describeEvent(payload), payload.createdAt);
  }
}
