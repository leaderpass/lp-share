import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { GUEST_COOKIE } from './viewer';
import { getUploadLinkByToken, type TeamFileRow, type UploadLink, type UploadRow } from './upload-db';
import { kindOf } from './upload-files';

/** The link behind a /api/u/{token} call, or the error response to send. */
export function activeLink(token: string): { link: UploadLink } | { res: NextResponse } {
  const link = getUploadLinkByToken(token);
  if (!link) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  if (!link.active) return { res: NextResponse.json({ error: 'This link is paused' }, { status: 403 }) };
  return { link };
}

export function guestId(): string | null {
  return cookies().get(GUEST_COOKIE)?.value ?? null;
}

/**
 * What the page shows for one file: a finished client upload, or a team file
 * (`from: 'team'`: no status, offered until `expiresAt`, New until this
 * browser downloads it).
 */
export interface PublicUpload {
  id: string; name: string; uploader: string; size: number; kind: string; at: string;
  from: 'client' | 'team';
  status: 'received' | 'added' | null; mine: boolean; removable: boolean;
  downloadable: boolean; isNew: boolean; expiresAt: string | null;
}

export function toPublic(u: UploadRow, guest: string | null): PublicUpload {
  const status = u.lpos_status === 'added' ? 'added' : 'received';
  const mine = !!guest && u.guest_id === guest;
  return {
    id: u.id, name: u.file_name, uploader: u.uploader_name, size: u.size, kind: kindOf(u.file_name, u.mime),
    at: u.completed_at ?? u.created_at, from: 'client', status, mine, removable: mine && status === 'received',
    downloadable: !u.file_gone, isNew: false, expiresAt: null,
  };
}

export const TEAM_SENDER = 'LeaderPass';

export function teamToPublic(f: TeamFileRow, seen: Set<string>): PublicUpload {
  return {
    id: f.id, name: f.file_name, uploader: TEAM_SENDER, size: f.size, kind: kindOf(f.file_name, f.mime),
    at: f.added_at, from: 'team', status: null, mine: false, removable: false,
    downloadable: true, isNew: !seen.has(f.id), expiresAt: f.expires_at,
  };
}

// Per-link request cap (in memory; one instance).
const counts = new Map<string, { n: number; start: number }>();
export function rateLimited(token: string, max = 300, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const e = counts.get(token);
  if (!e || now - e.start > windowMs) { counts.set(token, { n: 1, start: now }); return false; }
  e.n += 1;
  return e.n > max;
}
