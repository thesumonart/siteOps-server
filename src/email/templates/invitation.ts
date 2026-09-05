import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

export interface InvitationProps {
  readonly organizationName: string;
  readonly invitedByName: string;
  readonly acceptUrl: string;
  readonly expiresInDays: number;
}

export function invitationTemplate(props: InvitationProps): EmailContent {
  const options: LayoutOptions = {
    heading: `Join ${props.organizationName} on SiteOps`,
    paragraphs: [
      `${props.invitedByName} invited you to help monitor the websites ${props.organizationName} looks after.`,
      'Accept the invitation to see uptime, response times and incidents for every site in the organization.',
    ],
    action: { label: 'Accept invitation', url: props.acceptUrl },
    footnote: `This invitation expires in ${props.expiresInDays} days and works only for the address it was sent to. If you were not expecting it, you can ignore this email.`,
  };

  return {
    subject: `${props.invitedByName} invited you to ${props.organizationName} on SiteOps`,
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
