import { formatDuration } from '../../contracts/index.js';
import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

/**
 * A website that is answering, but far more slowly than it usually does.
 *
 * Worded as "slow", never "down": the site is up, and an alert that sounds
 * like an outage for something that is not one teaches people to read the next
 * outage alert less urgently. Amber in the subject, as for a monitor warning.
 */

export interface WebsiteDegradedProps {
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly responseTimeMs: number;
  readonly baselineMeanMs: number;
  readonly baselineStdDevMs: number;
  readonly sampleCount: number;
  readonly anomalousChecks: number;
  readonly dashboardUrl: string;
}

export function websiteDegradedTemplate(props: WebsiteDegradedProps): EmailContent {
  const options: LayoutOptions = {
    heading: `${props.websiteName} is responding slowly`,
    paragraphs: [
      `${props.websiteName} (${props.websiteUrl}) is still up, but its last ${String(props.anomalousChecks)} checks were far slower than usual.`,
      `The latest took ${String(Math.round(props.responseTimeMs))} ms, against a usual ${String(Math.round(props.baselineMeanMs))} ms (± ${String(Math.round(props.baselineStdDevMs))} ms) over its previous ${String(props.sampleCount)} successful checks.`,
      "You'll get one more email when response times are back to normal. This alert will not repeat while it stays slow.",
    ],
    action: { label: 'View website', url: props.dashboardUrl },
  };

  return {
    subject: `🟠 ${props.websiteName} is responding slowly`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}

export interface WebsiteDegradationResolvedProps {
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly resolvedAt: Date;
  readonly durationSeconds: number;
  readonly dashboardUrl: string;
}

export function websiteDegradationResolvedTemplate(
  props: WebsiteDegradationResolvedProps,
): EmailContent {
  const options: LayoutOptions = {
    heading: `${props.websiteName} is back to its usual speed`,
    paragraphs: [
      `Response times on ${props.websiteName} (${props.websiteUrl}) are back to normal as of ${props.resolvedAt.toUTCString()}.`,
      `It was slow for ${formatDuration(props.durationSeconds)}.`,
    ],
    action: { label: 'View website', url: props.dashboardUrl },
  };

  return {
    subject: `🟢 ${props.websiteName} is back to its usual speed`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
