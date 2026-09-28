import 'server-only';
import { NextResponse } from 'next/server';
import { getShareByToken } from './share-db';
import { currentViewer, shareAccess, type Viewer } from './viewer';
import type { Share } from './types';

/** Resolve /api/s/{token}/… — the share plus viewer, or the response to send back. */
export function resolveShareRequest(token: string):
  | { share: Share; viewer: Viewer; deny: null }
  | { share: null; viewer: null; deny: NextResponse } {
  const share = getShareByToken(token);
  const viewer = currentViewer();
  const access = shareAccess(share, viewer);
  if (!access.ok) {
    const status = access.reason === 'gone' ? 410 : access.reason === 'signin' ? 401 : 403;
    return { share: null, viewer: null, deny: NextResponse.json({ error: 'You can’t open this share.' , reason: access.reason }, { status }) };
  }
  return { share: share!, viewer, deny: null };
}
