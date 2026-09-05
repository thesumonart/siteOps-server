/**
 * Shared HTML shell for every transactional email.
 *
 * Email clients are roughly a 2005 browser: no external stylesheets, no custom
 * properties, unreliable flexbox. So this uses a table, inline styles and web-
 * safe fonts on purpose — the design tokens from the app cannot be reused here.
 */

/** Escapes text interpolated into HTML. Every template value passes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LayoutOptions {
  readonly heading: string;
  /** Paragraphs of body copy, already plain text. */
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Small print below the action, e.g. link expiry. */
  readonly footnote?: string;
}

const BRAND = '#4f46e5';
const TEXT = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const CANVAS = '#f8fafc';

export function renderLayout(options: LayoutOptions): string {
  const { heading, paragraphs, action, footnote } = options;

  const body = paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${TEXT};">${escapeHtml(paragraph)}</p>`,
    )
    .join('');

  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
        <tr>
          <td style="border-radius:6px;background:${BRAND};">
            <a href="${escapeHtml(action.url)}"
               style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
              ${escapeHtml(action.label)}
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${MUTED};">
        If the button does not work, copy this link into your browser:
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;">
        <a href="${escapeHtml(action.url)}" style="color:${BRAND};">${escapeHtml(action.url)}</a>
      </p>`
    : '';

  const note = footnote
    ? `<p style="margin:0;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(footnote)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;">
        <tr>
          <td style="padding:28px 28px 8px;">
            <span style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:${TEXT};">SiteOps</span>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
            <h1 style="margin:8px 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${TEXT};">${escapeHtml(heading)}</h1>
            ${body}
            ${button}
            ${note}
          </td>
        </tr>
      </table>
      <p style="margin:20px 0 0;font-size:12px;line-height:18px;color:${MUTED};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        SiteOps — website monitoring
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Plain-text counterpart, generated from the same content. */
export function renderPlainText(options: LayoutOptions): string {
  const parts = [options.heading, '', ...options.paragraphs];
  if (options.action) {
    parts.push('', `${options.action.label}: ${options.action.url}`);
  }
  if (options.footnote) {
    parts.push('', options.footnote);
  }
  parts.push('', '— SiteOps');
  return parts.join('\n');
}
