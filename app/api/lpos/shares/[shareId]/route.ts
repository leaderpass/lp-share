import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { deleteShare } from '@/lib/share-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE — LPOS deleted the share outright (revoking pushes `revoked: true` instead). */
export async function DELETE(req: Request, { params }: { params: { shareId: string } }) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  deleteShare(params.shareId);
  return NextResponse.json({ ok: true });
}
