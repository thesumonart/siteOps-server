import { CHECK_ERROR_LABELS, type CheckErrorType } from '../../contracts/index.js';
import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

export interface WebsiteDownProps {
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly startedAt: Date;
  readonly failedCheckCount: number;
  readonly lastStatusCode: number | null;
  readonly lastErrorType: CheckErrorType | null;
  readonly dashboardUrl: string;
}

function describeFailure(props: WebsiteDownProps): string {
  if (props.lastStatusCode !== null) {
    return `The last check received HTTP ${props.lastStatusCode}.`;
  }
  if (props.lastErrorType) {
    return `The last check failed: ${CHECK_ERROR_LABELS[props.lastErrorType]}.`;
  }
  return 'The last check failed.';
}

export function websiteDownTemplate(props: WebsiteDownProps): EmailContent {
  const options: LayoutOptions = {
    heading: `${props.websiteName} is down`,
    paragraphs: [
      `${props.websiteName} (${props.websiteUrl}) stopped responding at ${props.startedAt.toUTCString()}, after ${props.failedCheckCount} consecutive failed checks.`,
      describeFailure(props),
      "You'll get one more email when it recovers. This alert will not repeat while it stays down.",
    ],
    action: { label: 'View incident', url: props.dashboardUrl },
  };

  return {
    subject: `🔴 ${props.websiteName} is down`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
