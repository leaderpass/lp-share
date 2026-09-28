import { redirect } from 'next/navigation';
import { sessionEmail } from '@/lib/auth';
import { hubsForEmail } from '@/lib/db';
import { sharesForEmail } from '@/lib/share-db';

export const dynamic = 'force-dynamic';

export default function Home() {
  const email = sessionEmail();
  if (!email) redirect('/signin');

  // Shares addressed to this email, plus any Link Hubs not converted yet.
  const shares = sharesForEmail(email);
  const converted = new Set(shares.map((s) => s.legacy_hub_id).filter(Boolean));
  const hubs = hubsForEmail(email).filter((h) => !converted.has(h.id));
  if (shares.length === 1 && hubs.length === 0) redirect(`/s/${shares[0].token}`);
  if (shares.length === 0 && hubs.length === 0) {
    return (
      <div className="shell">
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <a href="/api/auth/signout" className="signout">Sign out</a>
        </div>
        <div className="empty">This sign-in has no video library yet. Ask your LeaderPass contact.</div>
      </div>
    );
  }
  // one hub → straight in; many → switcher
  if (hubs.length === 1 && shares.length === 0) redirect(`/h/${hubs[0].id}`);

  return (
    <div className="shell">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <a href="/api/auth/signout" className="signout">Sign out</a>
      </div>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div className="sec-eyebrow">Signed in as {email}</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '6px 0 4px', color: 'var(--text-strong)' }}>Your videos</h1>
      </div>
      {shares.map((s) => (
        <a key={s.id} href={`/s/${s.token}`} className="hcard">
          <span className="hi" aria-hidden>
            <svg viewBox="0 0 24 24" strokeWidth={1.7}>
              <rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" />
              <rect x="3" y="14" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" />
            </svg>
          </span>
          <span>
            <span className="hh" style={{ display: 'block' }}>{s.name}</span>
            <span className="hm">{s.video_count} video{s.video_count === 1 ? '' : 's'}</span>
          </span>
          <span className="arrow" aria-hidden>
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          </span>
        </a>
      ))}
      {hubs.map((h) => (
        <a key={h.id} href={`/h/${h.id}`} className="hcard">
          <span className="hi" aria-hidden>
            <svg viewBox="0 0 24 24" strokeWidth={1.7}>
              <rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" />
              <rect x="3" y="14" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" />
            </svg>
          </span>
          <span>
            <span className="hh" style={{ display: 'block' }}>{h.name}</span>
            <span className="hm">{h.owner_label}</span>
          </span>
          <span className="arrow" aria-hidden>
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          </span>
        </a>
      ))}
    </div>
  );
}
