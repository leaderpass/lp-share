import { notFound } from 'next/navigation';
import { videoByToken, recordView } from '@/lib/db';
import { itemByVideoToken } from '@/lib/share-db';
import { currentViewer, videoAccess } from '@/lib/viewer';
import { buildVideoViewModel } from '@/lib/view';
import { ShareViewer } from '@/components/ShareViewer';
import { Gate } from '@/components/Gate';

export const dynamic = 'force-dynamic';

// Public sample clips used only for placeholder (demo-uid-*) assets so a
// walkthrough has something that actually plays. Real assets use Cloudflare.
const DEMO_SAMPLES = [
  'ForBiggerBlazes',
  'ForBiggerEscapes',
  'ForBiggerFun',
  'ForBiggerJoyrides',
  'ForBiggerMeltdowns',
].map((n) => `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/${n}.mp4`);

/**
 * Single-video link. LP Share items play in the share player (playback only);
 * tokens still only in the legacy Link Hub tables fall back to the old
 * Cloudflare embed until cutover.
 * Placeholder (demo) assets play a public sample clip instead.
 */
export default function WatchPage({ params }: { params: { token: string } }) {
  // LP Share video link (converted Link Hub tokens resolve here too).
  const hit = itemByVideoToken(params.token);
  if (hit) {
    const viewer = currentViewer();
    const access = videoAccess(hit.share, viewer);
    if (!access.ok) return <Gate reason={access.reason} next={`/v/${params.token}`} />;
    recordView(params.token);
    return <ShareViewer solo model={buildVideoViewModel(hit.share, hit.item, viewer)} />;
  }

  // Legacy Link Hub link (until its hub is converted into a share).
  const video = videoByToken(params.token);
  if (!video) notFound();

  recordView(params.token);

  const isDemo = video.cf_stream_uid.startsWith('demo');
  const cfSrc = `https://iframe.videodelivery.net/${video.cf_stream_uid}?primaryColor=%23dbaf5f&letterboxColor=%2305080b`;
  const demoSrc = DEMO_SAMPLES[params.token.charCodeAt(0) % DEMO_SAMPLES.length];

  return (
    <div className="player">
      <div className="pcol">
        <h1 className="ptitle-out">{video.title}</h1>
        <div className="screen">
          {isDemo && <span className="demo-badge">Demo</span>}
          {isDemo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={demoSrc}
              controls
              autoPlay
              muted
              loop
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
            />
          ) : (
            <iframe
              src={cfSrc}
              title={video.title}
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
              allowFullScreen
            />
          )}
        </div>
      </div>
    </div>
  );
}
