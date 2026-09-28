import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Thin, dependency-free magic-link + session auth.
 * A token is  base64url(payload) + "." + base64url(HMAC-SHA256(payload)).
 * Same scheme signs both the emailed magic-link token and the session cookie.
 */

export const SESSION_COOKIE = 'hub_session';
const MAGIC_TTL_MS = 20 * 60 * 1000; // 20 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The app's absolute origin for building redirect/link URLs.
 * Uses NEXT_PUBLIC_APP_ORIGIN (tolerating a missing scheme or trailing slash);
 * falls back to the request's own origin. Never returns a scheme-less value —
 * a bare host would make NextResponse.redirect throw "Invalid URL".
 */
export function appOrigin(req: Request): string {
  let o = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? '').trim();
  if (o) {
    if (!/^https?:\/\//i.test(o)) o = `https://${o}`;
    return o.replace(/\/+$/, '');
  }
  return new URL(req.url).origin;
}

function secret(): string {
  const s = process.env.SHARE_SECRET || process.env.LINK_HUB_SECRET;
  if (!s || s.length < 16) throw new Error('SHARE_SECRET is missing or too short');
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function sign(payload: object): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = b64url(createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

export function verify<T>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = b64url(createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(fromB64url(body).toString('utf8')) as { exp?: number };
    if (typeof data.exp === 'number' && Date.now() > data.exp) return null;
    return data as T;
  } catch {
    return null;
  }
}

// ── magic link ───────────────────────────────────────────────────────────────

export function mintMagicToken(email: string): string {
  return sign({ email: email.toLowerCase(), exp: Date.now() + MAGIC_TTL_MS, k: 'magic' });
}

export function verifyMagicToken(token: string): string | null {
  const data = verify<{ email: string; k: string }>(token);
  return data && data.k === 'magic' ? data.email : null;
}

// ── session cookie ─────────────────────────────────────────────────────────────

/** Cookie options shared by every place that writes the session cookie. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/** Signed session cookie value for `email`. Throws if LINK_HUB_SECRET is unset. */
export function makeSessionValue(email: string): string {
  return sign({ email: email.toLowerCase(), exp: Date.now() + SESSION_TTL_MS, k: 'sess' });
}

export function startSession(email: string): void {
  cookies().set(SESSION_COOKIE, makeSessionValue(email), sessionCookieOptions());
}

/** The logged-in email, or null. Read in server components / route handlers. */
export function sessionEmail(): string | null {
  const c = cookies().get(SESSION_COOKIE)?.value;
  if (!c) return null;
  const data = verify<{ email: string; k: string }>(c);
  return data && data.k === 'sess' ? data.email : null;
}

export function endSession(): void {
  cookies().delete(SESSION_COOKIE);
}
