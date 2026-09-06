import { formatUptimePercentage } from '../../contracts/index.js';
import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

/**
 * The email a scheduled report arrives in.
 *
 * The headline figures are in the body as well as the attachment, because this
 * is frequently read on a phone by someone who will not open a PDF, and "uptime
 * was 99.98% and there were two incidents" is the whole message most months.
 *
 * `brandName` is the agency's, not ours: this lands in their client's inbox.
 */
export interface ReportReadyProps {
  readonly title: string;
  readonly brandName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly websiteCount: number;
  readonly uptimePercentage: number | null;
  readonly incidentCount: number;
  readonly dashboardUrl: string;
  /** False when the render was too large to attach, so the copy changes. */
  readonly attached: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function reportReadyTemplate(props: ReportReadyProps): EmailContent {
  const period = `${formatDate(props.periodStart)} to ${formatDate(props.periodEnd)}`;

  const incidents =
    props.incidentCount === 0
      ? 'No incidents were recorded.'
      : `${String(props.incidentCount)} ${props.incidentCount === 1 ? 'incident was' : 'incidents were'} recorded.`;

  const options: LayoutOptions = {
    heading: props.title,
    paragraphs: [
      `Monitoring summary for ${period}, covering ${String(props.websiteCount)} ${props.websiteCount === 1 ? 'website' : 'websites'}.`,
      `Uptime across the period was ${formatUptimePercentage(props.uptimePercentage)}. ${incidents}`,
      props.attached
        ? 'The full report is attached.'
        : 'The full report was too large to attach; open it on the dashboard.',
    ],
    action: { label: 'View the full report', url: props.dashboardUrl },
    footnote: `Sent by ${props.brandName}.`,
  };

  return {
    subject: `${props.title} · ${period}`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
