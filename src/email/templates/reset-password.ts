import { renderLayout, renderPlainText, type LayoutOptions } from '../layout.js';
import { type EmailContent } from '../types.js';

export interface ResetPasswordProps {
  readonly name: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

export function resetPasswordTemplate(props: ResetPasswordProps): EmailContent {
  const options: LayoutOptions = {
    heading: 'Reset your password',
    paragraphs: [
      `Hi ${props.name},`,
      'We received a request to reset the password for your SiteOps account. Choose a new one using the link below.',
    ],
    action: { label: 'Choose a new password', url: props.resetUrl },
    // Deliberately reassuring rather than alarming: most of these are the
    // account owner forgetting their own password.
    footnote: `This link expires in ${props.expiresInMinutes} minutes and can be used once. If you did not request this, your password has not changed and no action is needed.`,
  };

  return {
    subject: 'Reset your SiteOps password',
    html: renderLayout(options),
    text: renderPlainText(options),
  };
}
