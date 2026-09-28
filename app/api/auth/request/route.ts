import { NextResponse } from 'next/server';
import { mintMagicToken, appOrigin } from '@/lib/auth';
import { safeNext } from '@/lib/viewer';
import { sendMagicLink } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { email } → email a magic sign-in link.
 * We mint regardless of whether the email has access (don't leak which emails
 * are provisioned); the callback simply grants a session, and each hub still
 * checks access on entry. In dev the link is returned so you can click through.
 */
export async function POST(req: Request) {
  const { email, next } = (await req.json().catch(() => ({}))) as { email?: string; next?: string };
  const clean = (email ?? '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) {
    return NextResponse.json({ ok: false, error: 'invalid email' }, { status: 400 });
  }

  const token = mintMagicToken(clean);
  const origin = appOrigin(req);
  const back = safeNext(next, '');
  const link = `${origin}/api/auth/callback?token=${encodeURIComponent(token)}${back ? `&next=${encodeURIComponent(back)}` : ''}`;

  const isDev = process.env.NODE_ENV !== 'production';
  let sent = false;
  try {
    sent = await sendMagicLink(clean, link);
  } catch (err) {
    console.error('[magic-link] send failed:', (err as Error).message);
  }
  // Not sent (Resend not configured, or it failed) → surface the link in dev only.
  if (!sent && isDev) console.log('[magic-link]', clean, '→', link);

  return NextResponse.json({ ok: true, ...(!sent && isDev ? { devLink: link } : {}) });
}
