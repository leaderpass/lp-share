'use client';
import { useState } from 'react';

const DEMO_LOGINS = [
  { email: 'orlando@blackbird.co', label: 'Orlando — 2 hubs (hub switcher)' },
  { email: 'team@leaderpass.com', label: 'LeaderPass — client showcase' },
  { email: 'priya@vanguardwealth.com', label: 'Priya — Vanguard Wealth' },
];

export function SignInForm({ demo = false, next }: { demo?: boolean; next?: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, next }),
      });
      const data = await res.json();
      setSent(true);
      // dev only: the API returns the link so you can click through without email
      setDevLink(data.devLink ?? null);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <p style={{ color: 'var(--muted)' }}>
          If <b style={{ color: 'var(--text)' }}>{email}</b> has access, a sign-in link is on its way.
        </p>
        {devLink && (
          <p className="muted" style={{ marginTop: 12 }}>
            dev shortcut:&nbsp;<a href={devLink} style={{ color: 'var(--accent-strong)' }}>open the magic link →</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <form className="rowform" onSubmit={submit}>
        <input
          className="input"
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
        <button className="btn btn-gold" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Email me a link'}
        </button>
      </form>

      {demo && (
        <div style={{ marginTop: 26, width: 'min(410px, 90vw)' }}>
          <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            demo sign-in
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DEMO_LOGINS.map((d) => (
              <a
                key={d.email}
                href={`/api/auth/demo?email=${encodeURIComponent(d.email)}`}
                className="hcard"
                style={{ marginBottom: 0, textAlign: 'left' }}
              >
                <span className="hi" aria-hidden>
                  <svg viewBox="0 0 24 24" strokeWidth={1.7}>
                    <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0" fill="none" />
                  </svg>
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="hh" style={{ display: 'block' }}>{d.email}</span>
                  <span className="hm">{d.label}</span>
                </span>
                <span className="arrow" aria-hidden>
                  <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
