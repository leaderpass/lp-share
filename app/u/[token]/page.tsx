import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getUploadLinkByToken } from '@/lib/upload-db';
import { UploadPage } from '@/components/UploadPage';
import '../../upload.css';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { token: string } }): Metadata {
  const link = getUploadLinkByToken(params.token);
  return { title: link?.active && link.project_name ? `${link.project_name} · Upload · LeaderPass` : 'LeaderPass', robots: { index: false, follow: false } };
}

/** Client Upload Link page (spec §12.4). */
export default function ClientUploadPage({ params }: { params: { token: string } }) {
  const link = getUploadLinkByToken(params.token);
  if (!link) notFound();
  if (!link.active) {
    return (
      <div className="shv-root">
        <header className="shv-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <div className="shv-head-left"><img className="shv-logo" src="/share-logo.png" alt="LeaderPass" /></div>
        </header>
        <div className="shv-empty">This link is paused.</div>
      </div>
    );
  }
  return (
    <UploadPage
      token={link.token}
      title={link.project_name || 'Upload'}
      greeting={link.welcome_name || link.client_name || ''}
    />
  );
}
