import {
  MONITOR_TYPE_LABELS,
  type MonitorFinding,
  type MonitorStatus,
  type MonitorType,
} from '../../contracts/index.js';
import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

/**
 * Alerts from the auxiliary monitors.
 *
 * One template for all six rather than six near-identical ones. What differs
 * between an expiring certificate and a broken-link report is the wording of a
 * heading and a list of findings, and six copies of the same layout is six
 * places for the unsubscribe line to drift.
 *
 * The findings list is capped in the email even though the result document
 * holds more. An alert exists to make someone open the dashboard, and a mail
 * client rendering four hundred broken URLs achieves the opposite.
 */

const MAX_LISTED_FINDINGS = 8;

/**
 * Subject prefixes.
 *
 * A red circle for something broken now, amber for something that will break.
 * Emoji rather than `[CRITICAL]` because these land in a personal inbox next to
 * everything else, and the glyph survives a truncated subject line on a phone.
 */
const STATUS_MARK: Record<'failing' | 'warning', string> = {
  failing: '🔴',
  warning: '🟠',
};

export interface MonitorAlertProps {
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly monitorType: MonitorType;
  readonly status: Extract<MonitorStatus, 'failing' | 'warning'>;
  readonly summary: string;
  readonly findings: readonly MonitorFinding[];
  readonly detectedAt: Date;
  readonly dashboardUrl: string;
}

export function monitorAlertTemplate(props: MonitorAlertProps): EmailContent {
  const label = MONITOR_TYPE_LABELS[props.monitorType];

  const listed = props.findings.slice(0, MAX_LISTED_FINDINGS);
  const remaining = props.findings.length - listed.length;

  const paragraphs = [
    `${props.summary}`,
    `Found on ${props.websiteName} (${props.websiteUrl}) at ${props.detectedAt.toUTCString()}.`,
    ...listed.map((finding) =>
      finding.detail ? `• ${finding.message} — ${finding.detail}` : `• ${finding.message}`,
    ),
  ];

  if (remaining > 0) {
    paragraphs.push(`…and ${String(remaining)} more. The full list is on the dashboard.`);
  }

  paragraphs.push(
    "You'll get one more email when this clears. This alert will not repeat while it stands.",
  );

  const options: LayoutOptions = {
    heading: `${label}: ${props.websiteName}`,
    paragraphs,
    action: { label: 'View details', url: props.dashboardUrl },
  };

  return {
    subject: `${STATUS_MARK[props.status]} ${label} on ${props.websiteName}`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}

export interface MonitorRecoveredProps {
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly monitorType: MonitorType;
  readonly summary: string;
  readonly resolvedAt: Date;
  readonly dashboardUrl: string;
}

export function monitorRecoveredTemplate(props: MonitorRecoveredProps): EmailContent {
  const label = MONITOR_TYPE_LABELS[props.monitorType];

  const options: LayoutOptions = {
    heading: `${label} is healthy again: ${props.websiteName}`,
    paragraphs: [
      `The ${label.toLowerCase()} check on ${props.websiteName} (${props.websiteUrl}) is passing again as of ${props.resolvedAt.toUTCString()}.`,
      props.summary,
    ],
    action: { label: 'View details', url: props.dashboardUrl },
  };

  return {
    subject: `🟢 ${label} resolved on ${props.websiteName}`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
