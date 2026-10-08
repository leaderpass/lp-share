'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '@/lib/format';
import { BLOCKED_EXTENSIONS, extensionOf } from '@/lib/upload-files';

/**
 * Client Upload Link page (spec §12.4): drop files, watch them upload
 * (browser → R2 multipart, 4 parts at a time, per-part retry, resumable after
 * a reload by dropping the same file again), and see everything sent through
 * this link.
 */

const NAME_KEY = 'lp-share:name';
const RESUME_KEY = 'lp-share:upload-resume';
const PARALLEL = 4;
const MAX_ATTEMPTS = 6;

interface ListedUpload {
  id: string; name: string; uploader: string; size: number; kind: string; at: string;
  status: 'received' | 'added'; mine: boolean; removable: boolean;
}

interface QueueItem {
  localId: string;
  file: File;
  state: 'waiting' | 'uploading' | 'finishing' | 'failed';
  loaded: number;
  error?: string;
  uploadId?: string;
}

type Sort = 'newest' | 'oldest' | 'name' | 'size' | 'type';
type KindFilter = 'all' | 'video' | 'audio' | 'image' | 'document' | 'other';

function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}

// Unfinished uploads by file fingerprint, so dropping the same file again resumes it.
function resumeMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function setResume(fp: string, uploadId: string | null) {
  try {
    const m = resumeMap();
    if (uploadId) m[fp] = uploadId; else delete m[fp];
    localStorage.setItem(RESUME_KEY, JSON.stringify(m));
  } catch { /* private mode */ }
}
const fingerprint = (token: string, f: File) => `${token}:${f.name}:${f.size}:${f.lastModified}`;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new HttpError(res.status, data.error ?? 'Something went wrong');
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, xhrs: Set<XMLHttpRequest>): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.add(xhr);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      xhrs.delete(xhr);
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new HttpError(xhr.status, xhr.status >= 200 && xhr.status < 300 ? 'missing ETag' : `part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => { xhrs.delete(xhr); reject(new HttpError(0, 'network error')); };
    xhr.onabort = () => { xhrs.delete(xhr); reject(new HttpError(-1, 'cancelled')); };
    xhr.send(blob);
  });
}

function groupOf(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dow = (now.getDay() + 6) % 7;   // Monday = 0
  const weekStart = today - dow * 86_400_000;
  if (t >= today) return 'Today';
  if (t >= weekStart) return 'This week';
  if (t >= weekStart - 7 * 86_400_000) return 'Last week';
  return 'Earlier';
}
const GROUPS = ['Today', 'This week', 'Last week', 'Earlier'];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function UploadPage({ token, title, greeting }: Readonly<{ token: string; title: string; greeting: string }>) {
  const base = `/api/u/${encodeURIComponent(token)}/uploads`;
  const [uploads, setUploads] = useState<ListedUpload[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [name, setName] = useState('');
  const [askName, setAskName] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [kind, setKind] = useState<KindFilter>('all');
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  const cancelRef = useRef(new Map<string, { cancelled: boolean; xhrs: Set<XMLHttpRequest> }>());
  queueRef.current = queue;

  useEffect(() => { setName(readName()); }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ uploads: ListedUpload[] }>(base);
      setUploads(data.uploads);
      setListError(null);
    } catch (err) {
      setListError((err as Error).message);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const busy = queue.some((q) => q.state !== 'failed');
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const patch = useCallback((localId: string, p: Partial<QueueItem>) => {
    setQueue((q) => q.map((i) => (i.localId === localId ? { ...i, ...p } : i)));
  }, []);

  const uploadOne = useCallback(async (item: QueueItem, uploader: string) => {
    const ctl = { cancelled: false, xhrs: new Set<XMLHttpRequest>() };
    cancelRef.current.set(item.localId, ctl);
    const file = item.file;
    const fp = fingerprint(token, file);
    patch(item.localId, { state: 'uploading', error: undefined });

    // Start, or resume an unfinished upload of the same file from this browser.
    let uploadId: string | undefined = item.uploadId ?? resumeMap()[fp];
    let partSize = 0;
    let total = 0;
    const etags = new Map<number, string>();
    if (uploadId) {
      try {
        const r = await api<{ partSize: number; partCount: number; done: Array<{ n: number; etag: string }> }>(`${base}/${uploadId}`);
        partSize = r.partSize; total = r.partCount;
        for (const p of r.done) etags.set(p.n, p.etag);
      } catch { uploadId = undefined; etags.clear(); }
    }
    if (!uploadId) {
      const r = await api<{ uploadId: string; partSize: number; partCount: number }>(base, {
        method: 'POST', body: JSON.stringify({ fileName: file.name, size: file.size, contentType: file.type, uploaderName: uploader }),
      });
      uploadId = r.uploadId; partSize = r.partSize; total = r.partCount;
    }
    setResume(fp, uploadId);
    patch(item.localId, { uploadId });

    const partBytes = (n: number) => Math.min(partSize, file.size - (n - 1) * partSize);
    let doneBytes = [...etags.keys()].reduce((s, n) => s + partBytes(n), 0);
    const inflight = new Map<number, number>();
    const report = () => patch(item.localId, { loaded: doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0) });
    report();

    const pending = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !etags.has(n));
    const urls = new Map<number, string>();
    let fetching: Promise<void> | null = null;
    const urlFor = async (n: number, fresh = false): Promise<string> => {
      if (fresh) urls.delete(n);
      while (!urls.has(n)) {
        if (!fetching) {
          const want = [n, ...pending.filter((p) => p !== n && !urls.has(p) && !etags.has(p))].slice(0, 100);
          fetching = api<{ urls: Record<string, string> }>(`${base}/${uploadId}/parts`, { method: 'POST', body: JSON.stringify({ parts: want }) })
            .then((r) => { for (const [k, v] of Object.entries(r.urls)) urls.set(Number(k), v); })
            .finally(() => { fetching = null; });
        }
        await fetching;
      }
      return urls.get(n)!;
    };

    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const n = pending[next++];
        const blob = file.slice((n - 1) * partSize, (n - 1) * partSize + partBytes(n));
        for (let attempt = 1; ; attempt++) {
          if (ctl.cancelled) throw new HttpError(-1, 'cancelled');
          try {
            const etag = await putPart(await urlFor(n, attempt > 1), blob, (l) => { inflight.set(n, l); report(); }, ctl.xhrs);
            etags.set(n, etag);
            inflight.delete(n);
            doneBytes += blob.size;
            report();
            break;
          } catch (err) {
            inflight.delete(n);
            if (ctl.cancelled || (err as HttpError).status === -1 || attempt >= MAX_ATTEMPTS) throw err;
            await sleep(Math.min(30_000, 1000 * 2 ** attempt));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, pending.length)) }, worker));

    patch(item.localId, { state: 'finishing' });
    await api(`${base}/${uploadId}/complete`, {
      method: 'POST', body: JSON.stringify({ parts: [...etags].map(([n, etag]) => ({ n, etag })) }),
    });
    setResume(fp, null);
  }, [base, patch, token]);

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const item = queueRef.current.find((q) => q.state === 'waiting');
        if (!item) break;
        try {
          await uploadOne(item, readName());
          setQueue((q) => q.filter((i) => i.localId !== item.localId));
          void refresh();
        } catch (err) {
          if (cancelRef.current.get(item.localId)?.cancelled) continue;
          patch(item.localId, { state: 'failed', error: (err as Error).message });
        } finally {
          cancelRef.current.delete(item.localId);
        }
        await sleep(0);
      }
    } finally {
      runningRef.current = false;
    }
  }, [patch, refresh, uploadOne]);

  const enqueue = useCallback((files: File[]) => {
    const ok: QueueItem[] = [];
    const refused: string[] = [];
    for (const f of files) {
      if (BLOCKED_EXTENSIONS.has(extensionOf(f.name)) || f.size === 0) refused.push(f.name);
      else ok.push({ localId: crypto.randomUUID(), file: f, state: 'waiting', loaded: 0 });
    }
    if (refused.length) setToast(`Can't upload ${refused.length === 1 ? refused[0] : `${refused.length} files`}`);
    if (!ok.length) return;
    queueRef.current = [...queueRef.current, ...ok];
    setQueue(queueRef.current);
    void pump();
  }, [pump]);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    if (!readName().trim()) { setAskName(files); return; }
    enqueue(files);
  }, [enqueue]);

  async function cancel(item: QueueItem) {
    const ctl = cancelRef.current.get(item.localId);
    if (ctl) { ctl.cancelled = true; for (const x of ctl.xhrs) x.abort(); }
    setQueue((q) => q.filter((i) => i.localId !== item.localId));
    setResume(fingerprint(token, item.file), null);
    if (item.uploadId) await fetch(`${base}/${item.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function retry(item: QueueItem) {
    patch(item.localId, { state: 'waiting', error: undefined });
    queueRef.current = queueRef.current.map((i) => (i.localId === item.localId ? { ...i, state: 'waiting' } : i));
    void pump();
  }

  async function remove(u: ListedUpload) {
    if (!window.confirm(`Remove ${u.name}?`)) return;
    try {
      await api(`${base}/${u.id}`, { method: 'DELETE' });
      setUploads((list) => list?.filter((x) => x.id !== u.id) ?? null);
    } catch (err) {
      setToast((err as Error).message);
      void refresh();
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (uploads ?? []).filter((u) =>
      (kind === 'all' || u.kind === kind) && (!q || u.name.toLowerCase().includes(q) || u.uploader.toLowerCase().includes(q)));
    const cmp: Record<Sort, (a: ListedUpload, b: ListedUpload) => number> = {
      newest: (a, b) => b.at.localeCompare(a.at),
      oldest: (a, b) => a.at.localeCompare(b.at),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => b.size - a.size,
      type: (a, b) => a.kind.localeCompare(b.kind) || extensionOf(a.name).localeCompare(extensionOf(b.name)) || a.name.localeCompare(b.name),
    };
    return list.sort(cmp[sort]);
  }, [uploads, query, kind, sort]);

  const grouped = useMemo(() => {
    const now = new Date();
    const by = new Map<string, ListedUpload[]>();
    for (const u of visible) {
      const g = groupOf(u.at, now);
      by.set(g, [...(by.get(g) ?? []), u]);
    }
    const order = sort === 'oldest' ? [...GROUPS].reverse() : GROUPS;
    return order.filter((g) => by.has(g)).map((g) => ({ label: g, items: by.get(g)! }));
  }, [visible, sort]);

  const kinds = useMemo(() => new Set((uploads ?? []).map((u) => u.kind)), [uploads]);

  return (
    <div className="shv-root up-root">
      <header className="shv-head">
        <div className="shv-head-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="shv-logo" src="/share-logo.png" alt="LeaderPass" />
        </div>
        <div className="shv-head-center"><span className="shv-name">{title}</span></div>
        <div className="shv-head-right">
          <label className="shv-namefield">
            <span className="shv-namefield-label">Your name</span>
            <input value={name} placeholder="Add your name" maxLength={80}
              onChange={(e) => { setName(e.target.value); saveName(e.target.value.trim()); }} />
          </label>
        </div>
      </header>

      <main className="up-main">
        {greeting && <h1 className="up-greeting">Hi {greeting}</h1>}

        <div
          className={`up-drop${dragging ? ' is-over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>Drop files or <u>browse</u></span>
          <input ref={inputRef} type="file" multiple hidden
            onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>

        {queue.length > 0 && (
          <ul className="up-queue">
            {queue.map((q) => {
              const pct = q.file.size ? Math.floor((q.loaded / q.file.size) * 100) : 0;
              return (
                <li key={q.localId} className={`up-qrow${q.state === 'failed' ? ' is-failed' : ''}`}>
                  <div className="up-qtop">
                    <span className="up-fname" title={q.file.name}>{q.file.name}</span>
                    <span className="up-qmeta">
                      {q.state === 'failed' ? q.error
                        : q.state === 'waiting' ? 'Waiting'
                        : q.state === 'finishing' ? 'Finishing'
                        : `${pct}% · ${formatBytes(q.loaded)} of ${formatBytes(q.file.size)}`}
                    </span>
                    {q.state === 'failed' && <button type="button" className="up-link" onClick={() => retry(q)}>Retry</button>}
                    <button type="button" className="up-x" aria-label={`Cancel ${q.file.name}`} onClick={() => void cancel(q)}>×</button>
                  </div>
                  <div className="up-bar"><div style={{ width: `${q.state === 'finishing' ? 100 : pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="up-controls">
          <input className="up-search" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files" />
          <select className="sortsel" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="File type">
            <option value="all">All types</option>
            {(['video', 'audio', 'image', 'document', 'other'] as const).filter((k) => kinds.has(k) || kind === k).map((k) => (
              <option key={k} value={k}>{{ video: 'Video', audio: 'Audio', image: 'Images', document: 'Documents', other: 'Other' }[k]}</option>
            ))}
          </select>
          <select className="sortsel" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="type">Type</option>
          </select>
        </div>

        {listError && <p className="up-error">{listError}</p>}
        {uploads && uploads.length === 0 && <p className="up-empty">No files yet</p>}
        {uploads && uploads.length > 0 && visible.length === 0 && <p className="up-empty">No matches</p>}

        {grouped.map((g) => (
          <section key={g.label} className="up-group">
            <h2 className="up-group-label">{g.label}</h2>
            <ul className="up-list">
              {g.items.map((u) => (
                <li key={u.id} className="up-row">
                  <div className="up-rmain">
                    <span className="up-fname" title={u.name}>{u.name}</span>
                    <span className="up-rmeta">{u.uploader} · {formatBytes(u.size)} · {formatWhen(u.at)}</span>
                  </div>
                  <span className={`up-status${u.status === 'added' ? ' is-added' : ''}`}>{u.status === 'added' ? 'Added to project' : 'Received'}</span>
                  {u.removable
                    ? <button type="button" className="up-x" aria-label={`Remove ${u.name}`} title="Remove" onClick={() => void remove(u)}>×</button>
                    : <span className="up-x-spacer" />}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      {askName && <NamePrompt onDone={(n) => {
        const files = askName;
        setAskName(null);
        if (!n) return;
        setName(n); saveName(n);
        enqueue(files);
      }} />}
      {toast && <div className="shv-toast" role="status">{toast}</div>}
    </div>
  );
}

function NamePrompt({ onDone }: Readonly<{ onDone: (n: string | null) => void }>) {
  const [value, setValue] = useState('');
  return (
    <div className="shv-modal-overlay" onClick={() => onDone(null)}>
      <form className="shv-modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onDone(value.trim().slice(0, 80)); }}>
        <h2>What’s your name?</h2>
        <input autoFocus value={value} maxLength={80} placeholder="Your name" onChange={(e) => setValue(e.target.value)} />
        <div className="shv-modal-actions">
          <button type="button" className="shv-btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="shv-btn shv-btn--gold" disabled={!value.trim()}>Upload</button>
        </div>
      </form>
    </div>
  );
}
