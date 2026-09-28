import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * LPOS → LP Share calls carry the shared secret in `x-lpos-token`
 * (LPOS_INGEST_TOKEN). Returns a 401 response to send back, or null if OK.
 */
export function denyUnlessLpos(req: Request): NextResponse | null {
  const expected = process.env.LPOS_INGEST_TOKEN ?? '';
  const provided = req.headers.get('x-lpos-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = !!expected && !!provided && a.length === b.length && timingSafeEqual(a, b);
  return ok ? null : NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}
