import 'server-only';
import { Resend } from 'resend';

/**
 * Sends the magic sign-in link via Resend.
 *
 * Config (Doppler/Railway env):
 *   - RESEND_API_KEY      → your Resend API key (required to actually send)
 *   - SHARE_MAIL_FROM (or LINK_HUB_MAIL_FROM) → the From address, e.g. "LeaderPass <no-reply@leaderpass.com>"
 *                           (defaults to Resend's onboarding sender for first tests)
 *
 * Returns true if an email was sent; false if RESEND_API_KEY isn't set (the
 * caller then falls back to the dev shortcut). Throws only on a real send error.
 */
export async function sendMagicLink(to: string, link: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;

  const from = (process.env.SHARE_MAIL_FROM || process.env.LINK_HUB_MAIL_FROM)?.trim() || 'LeaderPass <onboarding@resend.dev>';
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Your LeaderPass sign-in link',
    text: [
      'Sign in to your LeaderPass video library:',
      '',
      link,
      '',
      'This link expires in 20 minutes. If you did not request it, you can ignore this email.',
    ].join('\n'),
    html: magicLinkHtml(link),
  });

  if (error) {
    throw new Error(typeof error === 'string' ? error : error.message ?? 'email send failed');
  }
  return true;
}

function magicLinkHtml(link: string): string {
  // Logo is served from this app's /public, on whatever origin the link uses.
  let origin = '';
  try {
    origin = new URL(link).origin;
  } catch {
    origin = '';
  }
  const logo = `${origin}/leaderpass-logo.png`;

  return `<!doctype html>
<html>
<body style="margin:0;background:#e9e9ec;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr><td align="center">
      <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="width:460px;max-width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e9e6df;border-radius:16px;overflow:hidden">
        <tr><td style="background:#121a22;padding:22px 32px 20px 32px">
          <img src="${logo}" alt="LeaderPass" width="140" style="display:block;width:140px;height:auto;border:0" />
          <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#dbaf5f;font-weight:700;margin-top:10px">Videos</div>
        </td></tr>
        <tr><td style="padding:26px 32px 4px 32px">
          <div style="font-size:21px;line-height:1.25;font-weight:700;letter-spacing:-.01em;color:#1a1d21">Here&rsquo;s your sign-in link</div>
        </td></tr>
        <tr><td style="padding:22px 32px 6px 32px">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            <tr><td style="border-radius:10px;background:#d9a441">
              <a href="${link}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#241a08;border-radius:10px;text-decoration:none">Open my videos &rarr;</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 32px 0 32px">
          <div style="font-size:12.5px;color:#8b9097;margin-bottom:6px">Or paste this link into your browser:</div>
          <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#5f656c;background:#f6f5f2;border:1px solid #eceae4;border-radius:8px;padding:10px 12px;word-break:break-all">${link}</div>
        </td></tr>
        <tr><td style="padding:18px 32px 0 32px">
          <div style="font-size:12.5px;line-height:1.5;color:#9a9ea4">This link expires in 20 minutes. If you didn&rsquo;t request it, you can safely ignore this email.</div>
        </td></tr>
        <tr><td style="padding:22px 32px 26px 32px">
          <div style="border-top:1px solid #efece5;padding-top:16px;font-size:11.5px;color:#a9adb2">Sent by LeaderPass &middot; Video delivery</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
