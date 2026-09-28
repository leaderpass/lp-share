import type { Metadata } from 'next';
import { getShareByToken } from '@/lib/share-db';
import { currentViewer, shareAccess } from '@/lib/viewer';
import { buildViewModel } from '@/lib/view';
import { ShareViewer } from '@/components/ShareViewer';
import { Gate } from '@/components/Gate';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { token: string } }): Metadata {
  const share = getShareByToken(params.token);
  // Only reveal the name when the share would open for anyone.
  const open = share && !share.revoked && share.audience === 'link';
  return { title: open ? `${share!.name} · LeaderPass` : 'LeaderPass', robots: { index: false, follow: false } };
}

export default function SharePage({ params, searchParams }: { params: { token: string }; searchParams: { v?: string } }) {
  const share = getShareByToken(params.token);
  const viewer = currentViewer();
  const access = shareAccess(share, viewer);
  if (!access.ok) return <Gate reason={access.reason} next={`/s/${params.token}`} />;
  return <ShareViewer model={buildViewModel(share!, viewer)} initialAssetId={typeof searchParams.v === 'string' ? searchParams.v : undefined} />;
}
