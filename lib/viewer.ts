import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { sessionEmail, sign, verify } from './auth';
import { emailOnShare } from './share-db';
import type { Share } from './types';

/**
 * Who is looking at a share, and whether they may. See spec §2–§4.
 *   staff  — a staff pass from LPOS (`share_staff` cookie)
 *   email  — a magic-link sign-in (`hub_session` cookie)
 *   guest  — everyone gets a random `share_guest` id (set by middleware)
 */

export const STAFF_COOKIE = 'share_staff';
export const GUEST_COOKIE = 'share_guest';
const STAFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_MAX_AGE_MS = 5 * 60 * 1000;   // clock-skew backstop; tickets carry a 60s exp

export interface StaffIdentity { uid: string; name: string; email: string }

export interface Viewer {
  staff: StaffIdentity | null;
  email: string | null;
  guestId: string | null;
}

export function currentViewer(): Viewer {
  const raw = cookies().get(STAFF_COOKIE)?.value;
  const staff = raw ? verify<StaffIdentity & { k: string }>(raw) : null;
  return {
    staff: staff && staff.k === 'staff' ? { uid: staff.uid, name: staff.name, email: staff.email } : null,
    email: sessionEmail(),
    guestId: cookies().get(GUEST_COOKIE)?.value ?? null,
  };
}

export function staffCookieValue(s: StaffIdentity): string {
  return sign({ ...s, k: 'staff', exp: Date.now() + STAFF_TTL_MS });
}

export function staffCookieOptions() {
  return {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const,
    path: '/', maxAge: STAFF_TTL_MS / 1000,
  };
}

/**
 * Verify a ticket minted by LPOS /share-auth:
 *   base64url(json) "." base64url(HMAC-SHA256(base64url(json), SHARE_STAFF_SECRET))
 *   json = { k: "staff", uid, name, email, iat, exp, jti }
 * Single use is enforced by the caller (useStaffTicket).
 */
export function verifyStaffTicket(ticket: string): (StaffIdentity & { jti: string }) | null {
  const secret = process.env.SHARE_STAFF_SECRET ?? '';
  if (secret.length < 16) return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      k?: string; uid?: string; name?: string; email?: string; iat?: number; exp?: number; jti?: string;
    };
    const now = Date.now();
    if (d.k !== 'staff' || !d.uid || !d.jti || typeof d.exp !== 'number' || typeof d.iat !== 'number') return null;
    if (now > d.exp || now - d.iat > TICKET_MAX_AGE_MS) return null;
    return { uid: d.uid, name: d.name || 'LeaderPass', email: d.email ?? '', jti: d.jti };
  } catch {
    return null;
  }
}

/** Only same-origin paths may be redirected to after sign-in. */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : fallback;
}

export type Access =
  | { ok: true }
  | { ok: false; reason: 'gone' | 'staff' | 'signin' | 'not-listed' };

/** May this viewer open the whole share (/s/)? */
export function shareAccess(share: Share | null, v: Viewer): Access {
  if (!share || share.revoked) return { ok: false, reason: 'gone' };
  if (v.staff) return { ok: true };
  if (share.audience === 'staff') return { ok: false, reason: 'staff' };
  if (share.audience === 'email') {
    if (!v.email) return { ok: false, reason: 'signin' };
    if (!emailOnShare(share.id, v.email)) return { ok: false, reason: 'not-listed' };
  }
  return { ok: true };
}

/** May this viewer open a single-video link (/v/)? Reshare makes it forwardable. */
export function videoAccess(share: Share | null, v: Viewer): Access {
  if (!share || share.revoked || !share.caps.reshare) return { ok: false, reason: 'gone' };
  if (share.audience === 'staff' && !v.staff) return { ok: false, reason: 'staff' };
  return { ok: true };
}

/** Comment identity for the current viewer (null = can't comment as anyone). */
export function commentAuthor(v: Viewer, guestName: string | null): {
  author_name: string; author_kind: 'staff' | 'email' | 'guest';
  guest_id: string | null; email: string | null; staff_uid: string | null;
} | null {
  if (v.staff) return { author_name: v.staff.name, author_kind: 'staff', guest_id: null, email: v.staff.email || null, staff_uid: v.staff.uid };
  const name = (guestName ?? '').trim().slice(0, 80);
  if (v.email) return { author_name: name || v.email.split('@')[0], author_kind: 'email', guest_id: v.guestId, email: v.email, staff_uid: null };
  if (!v.guestId || !name) return null;
  return { author_name: name, author_kind: 'guest', guest_id: v.guestId, email: null, staff_uid: null };
}
