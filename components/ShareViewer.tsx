'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerMarker } from './Player';
import { Comments, type ViewComment } from './Comments';
import { formatBytes, formatDuration } from '@/lib/format';
import type { ViewItem, ViewModel } from '@/lib/view';

/**
 * The share viewer — LPOS's ShareViewer ported for LP Share. Fixed layout:
 * header · library · player · side panel. The share's switches only add or
 * remove pieces. `solo` is the single-video (/v/) link: playback only.
 */

const NAME_KEY = 'lp-share:name';

const IconLink = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" /></svg>);
const IconCheck = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>);
const IconDownload = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>);
const IconEye = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>);

function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode etc. */ }
}

type MenuItem = { label: string; onClick: () => void } | 'sep';

export function ShareViewer({ model, solo = false, initialAssetId }: Readonly<{ model: ViewModel; solo?: boolean; initialAssetId?: string }>) {
  const { share, viewer } = model;
  const caps = share.caps;
  const items = useMemo(() => model.groups.flatMap((g) => g.items), [model.groups]);
  const staff = !!viewer.staff;

  // ?v=<assetId> opens at that video (e.g. from an LPOS bell notification).
  const [assetId, setAssetId] = useState<string | null>(
    (initialAssetId && items.some((i) => i.assetId === initialAssetId) ? initialAssetId : null) ?? items[0]?.assetId ?? null,
  );
  const [clientView, setClientView] = useState(false);
  const [sideTab, setSideTab] = useState<'comments' | 'transcript'>('comments');
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [markers, setMarkers] = useState<PlayerMarker[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timeRef = useRef(0);

  // Name field (guests + email viewers). Remembered in this browser.
  const [name, setName] = useState('');
  useEffect(() => { setName(readName() || (viewer.email ? viewer.email.split('@')[0] : '')); }, [viewer.email]);
  const nameRef = useRef(name);
  nameRef.current = name;
  const [askName, setAskName] = useState<null | ((n: string | null) => void)>(null);
  const requestName = useCallback(() => new Promise<string | null>((resolve) => {
    setAskName(() => (n: string | null) => { setAskName(null); resolve(n); });
  }), []);

  // Count this open for LPOS's analytics. Sent from the browser (not the server
  // render) so link previews, which never run the page, aren't counted. Staff skip it.
  useEffect(() => {
    if (staff) return;
    const target = solo ? { v: items[0]?.videoToken } : { s: share.token };
    if (!target.v && !target.s) return;
    void fetch('/api/seen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ ...target, name: readName() || null }),
    }).catch(() => { /* analytics only */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item: ViewItem | null = items.find((i) => i.assetId === assetId) ?? items[0] ?? null;

  const commentsOn = caps.comments && !solo;
  const transcriptsOn = caps.transcripts && !solo;
  const activeTab: 'comments' | 'transcript' | null =
    sideTab === 'comments' && commentsOn ? 'comments'
      : sideTab === 'transcript' && transcriptsOn ? 'transcript'
      : commentsOn ? 'comments' : transcriptsOn ? 'transcript' : null;

  useEffect(() => { setMarkers([]); }, [item?.assetId]);
  const onComments = useCallback((list: ViewComment[]) => {
    setMarkers(list.filter((c) => !c.parentId).map((c) => ({
      id: c.id, timestamp: c.timestamp, duration: c.duration, completed: c.completed, authorName: c.authorName, text: c.text,
    })));
  }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const videoUrl = (i: ViewItem) => `${origin}/v/${i.videoToken}`;
  async function copyVideoLink(i: ViewItem, key: string) {
    try {
      await navigator.clipboard.writeText(videoUrl(i));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      flash('Couldn’t copy — your browser blocked the clipboard.');
    }
  }

  function startDownload(i: ViewItem, kind: string) {
    const a = document.createElement('a');
    a.href = `/api/s/${share.token}/download?asset=${encodeURIComponent(i.assetId)}&kind=${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function downloadItems(i: ViewItem): MenuItem[] {
    const d = i.download;
    if (!d || d.state !== 'ready') return [];
    return [
      ...(d.original ? [{ label: `Original · ${formatBytes(d.original.size)}`, onClick: () => startDownload(i, 'original') }] : []),
      ...(d.web ? [{ label: `Web (1080p) · ${formatBytes(d.web.size)}`, onClick: () => startDownload(i, 'web') }] : []),
      ...(d.transcripts.length ? ['sep' as const] : []),
      ...d.transcripts.map((k) => ({ label: `Transcript (.${k})`, onClick: () => startDownload(i, k) })),
    ];
  }
  function openMenuAt(e: React.MouseEvent, list: MenuItem[]) {
    e.stopPropagation();
    if (!list.length) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: Math.min(r.left, window.innerWidth - 220), y: r.bottom + 4, items: list });
  }
  function downloadAll(e: React.MouseEvent) {
    const ready = items.filter((i) => i.download?.state === 'ready');
    const all = (kind: string) => ready.forEach((i, n) => setTimeout(() => startDownload(i, kind), n * 600));
    openMenuAt(e, [
      { label: `All originals (${ready.length})`, onClick: () => all('original') },
      { label: `All web copies (${ready.length})`, onClick: () => all('web') },
    ]);
  }

  const showNameField = !solo && commentsOn && !staff;
  const header = (
    <header className="shv-head">
      <div className="shv-head-left">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="shv-logo" src="/share-logo.png" alt="LeaderPass" />
      </div>
      <div className="shv-head-center">
        <span className="shv-name">{share.name}</span>
        {caps.internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
      </div>
      <div className="shv-head-right">
        {!solo && caps.download && items.length > 1 && (
          <button type="button" className="shv-btn shv-btn--gold" onClick={downloadAll}
            disabled={!items.some((i) => i.download?.state === 'ready')}><IconDownload /> Download all</button>
        )}
        {showNameField && (
          <label className="shv-namefield" title="Shown next to your comments">
            <span className="shv-namefield-label">Your name</span>
            <input
              value={name}
              placeholder="Add your name"
              maxLength={80}
              onChange={(e) => { setName(e.target.value); saveName(e.target.value.trim()); }}
            />
          </label>
        )}
        {staff && !solo && !caps.internal && (
          <button type="button" className={`shv-icon-btn${clientView ? ' is-on' : ''}`} onClick={() => setClientView((v) => !v)}
            title={clientView ? 'Previewing as a client — click for staff view' : 'Preview as a client'} aria-pressed={clientView}>
            <IconEye />
          </button>
        )}
        {staff && !solo && <span className="shv-staff-badge" title={`Signed in as ${viewer.staff!.name} (LeaderPass staff)`}>{viewer.staff!.name.split(' ')[0]}</span>}
      </div>
    </header>
  );

  const overlays = (
    <>
      {menu && (
        <>
          <div className="shv-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="shv-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {menu.items.map((m, n) => m === 'sep'
              ? <div key={`s${n}`} className="shv-menu-sep" />
              : <button key={m.label} type="button" role="menuitem" className="shv-menu-item" onClick={() => { setMenu(null); m.onClick(); }}>{m.label}</button>)}
          </div>
        </>
      )}
      {askName && <NamePrompt initial={name} onDone={(n) => { if (n) { setName(n); saveName(n); } askName(n); }} />}
      {toast && <div className="shv-toast" role="status">{toast}</div>}
    </>
  );

  if (!item) {
    return <div className="shv-root">{header}<div className="shv-empty">There’s nothing in this share yet.</div></div>;
  }

  const player = item.hlsUrl ? (
    <Player
      key={item.assetId}
      src={item.hlsUrl}
      markers={commentsOn ? markers : []}
      seekTarget={seekTarget}
      onSeekHandled={() => setSeekTarget(null)}
      onCurrentTimeChange={(t) => { timeRef.current = t; }}
    />
  ) : <div className="shv-empty">This video isn’t available to play yet.</div>;

  if (solo) {
    return (
      <div className="shv-root">
        {header}
        <main className="shv-solo"><div className="shv-player">{player}</div></main>
        {overlays}
      </div>
    );
  }

  // Player off: a plain list of the videos with their download buttons (for
  // videos deliberately kept off Cloudflare, so there's nothing to stream).
  if (!caps.player) {
    return (
      <div className="shv-root">
        {header}
        <main className="shv-list">
          {model.groups.map((g, gi) => (
            <div key={g.title ?? `g${gi}`} className="shv-group">
              {g.title && <div className="shv-cat">{g.title}</div>}
              {g.items.map((i) => (
                <div key={i.assetId} className="shv-row-wrap">
                  <div className={`shv-row shv-row--static${rowClassFor(caps)}`}>
                    {i.thumbnailUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img className="shv-thumb" src={i.thumbnailUrl} alt="" loading="lazy" />
                      : <span className="shv-thumb" />}
                    <span className="shv-row-text">
                      <span className="shv-row-title">{i.title}</span>
                      <span className="shv-row-meta">{formatDuration(i.duration)}</span>
                    </span>
                  </div>
                  <span className="shv-row-actions">
                    {caps.reshare && (
                      <button type="button" className={`shv-icon-btn shv-row-copy${copiedKey === `row:${i.assetId}` ? ' is-copied' : ''}`}
                        onClick={() => void copyVideoLink(i, `row:${i.assetId}`)}
                        title={copiedKey === `row:${i.assetId}` ? 'Copied' : 'Copy video link'} aria-label="Copy video link">
                        {copiedKey === `row:${i.assetId}` ? <IconCheck /> : <IconLink />}
                      </button>
                    )}
                    {caps.download && <DownloadButton item={i} onOpen={(e) => openMenuAt(e, downloadItems(i))} />}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </main>
        {!staff && (
          <footer className="shv-foot">
            <a href={`/staff/start?next=${encodeURIComponent(`/s/${share.token}`)}`}>LeaderPass staff</a>
          </footer>
        )}
        {overlays}
      </div>
    );
  }

  const showLib = items.length > 1;
  const cols = ['shv-body', showLib ? '' : 'shv-body--nolib', activeTab ? '' : 'shv-body--noside'].filter(Boolean).join(' ');
  const rowClass = rowClassFor(caps);

  return (
    <div className="shv-root">
      {header}
      <div className={cols}>
        {showLib && (
          <nav className="shv-lib" aria-label="Videos">
            {model.groups.map((g, gi) => (
              <div key={g.title ?? `g${gi}`} className="shv-group">
                {g.title && <div className="shv-cat">{g.title}</div>}
                {g.items.map((i) => (
                  <div key={i.assetId} className="shv-row-wrap">
                    <button type="button" className={`shv-row${i.assetId === item.assetId ? ' is-sel' : ''}${rowClass}`}
                      onClick={() => { setAssetId(i.assetId); setSeekTarget(null); }}>
                      {i.thumbnailUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img className="shv-thumb" src={i.thumbnailUrl} alt="" loading="lazy" />
                        : <span className="shv-thumb" />}
                      <span className="shv-row-text">
                        <span className="shv-row-title">{i.title}</span>
                        <span className="shv-row-meta">{formatDuration(i.duration)}</span>
                      </span>
                    </button>
                    <span className="shv-row-actions">
                      {caps.reshare && (
                        <button type="button" className={`shv-icon-btn shv-row-copy${copiedKey === `row:${i.assetId}` ? ' is-copied' : ''}`}
                          onClick={() => void copyVideoLink(i, `row:${i.assetId}`)}
                          title={copiedKey === `row:${i.assetId}` ? 'Copied' : 'Copy video link'} aria-label="Copy video link">
                          {copiedKey === `row:${i.assetId}` ? <IconCheck /> : <IconLink />}
                        </button>
                      )}
                      {caps.download && <DownloadButton item={i} small onOpen={(e) => openMenuAt(e, downloadItems(i))} />}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </nav>
        )}

        <main className="shv-main">
          <div className="shv-player">{player}</div>
          <div className="shv-under">
            <h1 className="shv-title">{item.title}</h1>
            <span className="shv-grow" />
            {caps.reshare && (
              <button type="button" className={`shv-icon-btn${copiedKey === `under:${item.assetId}` ? ' is-copied' : ''}`}
                onClick={() => void copyVideoLink(item, `under:${item.assetId}`)}
                title={copiedKey === `under:${item.assetId}` ? 'Copied' : 'Copy video link'} aria-label="Copy video link">
                {copiedKey === `under:${item.assetId}` ? <IconCheck /> : <IconLink />}
              </button>
            )}
            {caps.download && <DownloadButton item={item} onOpen={(e) => openMenuAt(e, downloadItems(item))} />}
          </div>
          {staff && !clientView && item.lposName && item.lposName !== item.title && <div className="shv-staff-note">{item.lposName}</div>}
        </main>

        {activeTab && (
          <aside className="shv-side">
            {commentsOn && transcriptsOn && (
              <div className="shv-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={activeTab === 'comments'} className={activeTab === 'comments' ? 'is-on' : ''} onClick={() => setSideTab('comments')}>Comments</button>
                <button type="button" role="tab" aria-selected={activeTab === 'transcript'} className={activeTab === 'transcript' ? 'is-on' : ''} onClick={() => setSideTab('transcript')}>Transcript</button>
              </div>
            )}
            <div className="shv-side-body">
              {activeTab === 'comments' ? (
                <Comments
                  key={item.assetId}
                  token={share.token}
                  assetId={item.assetId}
                  staff={staff}
                  clientView={clientView}
                  internalShare={caps.internal}
                  getName={() => nameRef.current}
                  needsName={!staff}
                  requestName={requestName}
                  getCurrentTime={() => timeRef.current}
                  onSeek={(t) => setSeekTarget(t)}
                  onComments={onComments}
                />
              ) : (
                <Transcript token={share.token} item={item} onSeek={(t) => setSeekTarget(t)} />
              )}
            </div>
          </aside>
        )}
      </div>
      {!staff && (
        <footer className="shv-foot">
          <a href={`/staff/start?next=${encodeURIComponent(`/s/${share.token}`)}`}>LeaderPass staff</a>
        </footer>
      )}
      {overlays}
    </div>
  );
}

function rowClassFor(caps: ViewModel['share']['caps']): string {
  return caps.reshare && caps.download ? ' shv-row--two' : !caps.reshare && !caps.download ? ' shv-row--none' : '';
}

/** Per-video download button: opens Original / Web / transcripts; shows progress while files are prepared. */
function DownloadButton({ item, onOpen, small }: Readonly<{ item: ViewItem; onOpen: (e: React.MouseEvent) => void; small?: boolean }>) {
  const d = item.download;
  const ready = d?.state === 'ready';
  const title = ready ? 'Download'
    : d?.state === 'failed' ? `Download unavailable${d.error ? ` - ${d.error}` : ''}`
    : `Preparing download${d?.progress ? ` · ${d.progress}%` : ''}`;
  return (
    <button type="button"
      className={`shv-icon-btn shv-dl${small ? ' shv-dl--small' : ''}${ready ? '' : ' is-waiting'}${d?.state === 'failed' ? ' is-failed' : ''}`}
      onClick={(e) => { if (ready) onOpen(e); else e.stopPropagation(); }}
      aria-disabled={!ready} title={title} aria-label={title}>
      {ready || d?.state === 'failed' ? <IconDownload /> : <span className="shv-dl-spin" aria-hidden="true" />}
    </button>
  );
}

function Transcript({ token, item, onSeek }: Readonly<{ token: string; item: ViewItem; onSeek: (t: number) => void }>) {
  const [cues, setCues] = useState<Array<{ fromMs: number; text: string }> | null>(null);
  useEffect(() => {
    let live = true;
    setCues(null);
    fetch(`/api/s/${token}/transcript?asset=${encodeURIComponent(item.assetId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cues?: Array<{ fromMs: number; text: string }> } | null) => { if (live) setCues(d?.cues ?? []); })
      .catch(() => { if (live) setCues([]); });
    return () => { live = false; };
  }, [token, item.assetId]);

  if (cues === null) return <p className="mad-comments-empty">Loading…</p>;
  if (!cues.length) return <p className="mad-comments-empty">No transcript yet.</p>;
  return (
    <div className="shv-transcript">
      {cues.map((c) => (
        <button key={c.fromMs} type="button" className="shv-cue" onClick={() => onSeek(c.fromMs / 1000)}>
          <span className="shv-cue-tc">{formatDuration(Math.floor(c.fromMs / 1000)) || '0:00'}</span>
          <span>{c.text}</span>
        </button>
      ))}
    </div>
  );
}

/** "What's your name?" — shown the first time someone comments without one. */
function NamePrompt({ initial, onDone }: Readonly<{ initial: string; onDone: (n: string | null) => void }>) {
  const [value, setValue] = useState(initial);
  return (
    <div className="shv-modal-overlay" onClick={() => onDone(null)}>
      <form className="shv-modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onDone(value.trim().slice(0, 80)); }}>
        <h2>What’s your name?</h2>
        <p>It’s shown next to your comments so the LeaderPass team knows who they’re from.</p>
        <input autoFocus value={value} maxLength={80} placeholder="Your name" onChange={(e) => setValue(e.target.value)} />
        <div className="shv-modal-actions">
          <button type="button" className="shv-btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="shv-btn shv-btn--gold" disabled={!value.trim()}>Post comment</button>
        </div>
      </form>
    </div>
  );
}
