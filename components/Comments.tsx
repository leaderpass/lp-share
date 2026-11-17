'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCommentDate, formatTimecode } from '@/lib/format';
import { type CommentSpan, snapToFrame, spanDuration, dragSpanEdge, spanOf } from '@/lib/comment-span';
import { parseTimecode } from '@/lib/review-bar';

/**
 * A share's comments on one video — LPOS's AssetComments section ported for
 * LP Share. Rights come from the server (canEdit / canDelete); staff also get
 * complete + internal tags unless previewing as a client.
 */

export interface ViewComment {
  id: string;
  parentId: string | null;
  authorName: string;
  authorKind: 'guest' | 'email' | 'staff' | 'frameio';
  text: string;
  timestamp: number | null;
  duration: number | null;
  completed: boolean;
  internal: boolean;
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
  pending: boolean;
}

interface Thread extends ViewComment { replies: ViewComment[] }

interface Props {
  token: string;
  assetId: string;
  staff: boolean;
  /** Staff previewing as a client: hide staff-only affordances. */
  clientView: boolean;
  internalShare: boolean;
  /** Current name from the name field; asking for one if it's empty. */
  getName: () => string;
  needsName: boolean;
  requestName: () => Promise<string | null>;
  getCurrentTime: () => number;
  /** Span being drafted — shared with the player's scrub bar. */
  span: CommentSpan | null;
  onSpanChange: (span: CommentSpan | null) => void;
  /** The compose box took focus — pause the player. */
  onComposeFocus: () => void;
  /** Playhead, for the timecode the comment box follows and the "playing now" highlight. */
  playhead: number;
  /** The picked comment (from this list or the player's bar). */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Bump to focus the comment box (a range was just marked on the bar). */
  focusSignal: number;
  onComments: (c: ViewComment[]) => void;
}

type SortKey = 'time' | 'new';
const SORT_KEY = 'lpshare.commentSort';
/** A single-moment comment counts as "playing now" for this long. */
const MOMENT_S = 3;

const POLL_MS = 15_000;

function threads(list: ViewComment[]): Thread[] {
  const tops = list.filter((c) => !c.parentId).map((c) => ({ ...c, replies: [] as ViewComment[] }));
  const byId = new Map(tops.map((t) => [t.id, t]));
  for (const c of list) if (c.parentId) byId.get(c.parentId)?.replies.push(c);
  return tops;
}

const IconCheck = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>);
const IconEdit = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>);
const IconTrash = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>);

export function Comments({
  token, assetId, staff, clientView, internalShare, getName, needsName, requestName, getCurrentTime, span, onSpanChange, onComposeFocus,
  playhead, selectedId, onSelect, focusSignal, onComments,
}: Readonly<Props>) {
  const [list, setList] = useState<ViewComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composeText, setComposeText] = useState('');
  const composeInputRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<SortKey>('time');
  useEffect(() => {
    try { if (localStorage.getItem(SORT_KEY) === 'new') setSort('new'); } catch { /* storage off */ }
  }, []);
  function chooseSort(k: SortKey) {
    setSort(k);
    try { localStorage.setItem(SORT_KEY, k); } catch { /* storage off */ }
  }
  // The comment box's time: a chip that opens Point/Range + In/Out fields.
  const [whenOpen, setWhenOpen] = useState(false);
  const [inField, setInField] = useState('');
  const [outField, setOutField] = useState('');
  const [badField, setBadField] = useState<'in' | 'out' | null>(null);
  // Moving one of your own comments: the comment box holds its time until Save.
  const [timeEditId, setTimeEditId] = useState<string | null>(null);

  useEffect(() => { if (focusSignal) composeInputRef.current?.focus(); }, [focusSignal]);
  // A press outside the comment box closes the time menu (the player's bar doesn't: it adjusts the same time).
  useEffect(() => {
    if (!whenOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!composeRef.current?.contains(t) && !t.closest('.rb')) setWhenOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [whenOpen]);

  // I / O keys set the comment's in- and out-point at the playhead (as in
  // Frame.io); O also focuses the compose box. Ignored while typing anywhere.
  const spanRef = useRef(span);
  spanRef.current = span;
  const timeRef = useRef(getCurrentTime);
  timeRef.current = getCurrentTime;
  const setSpanRef = useRef(onSpanChange);
  setSpanRef.current = onSpanChange;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const key = e.key.toLowerCase();
      const cur = spanRef.current;
      if (key === 'i') {
        e.preventDefault();
        const t = snapToFrame(timeRef.current());
        setSpanRef.current({ start: t, end: cur?.end != null && cur.end > t ? cur.end : null });
      } else if (key === 'o') {
        e.preventDefault();
        const t = snapToFrame(timeRef.current());
        setSpanRef.current(cur ? dragSpanEdge(cur, 'end', t, 0) : { start: t, end: null });
        composeInputRef.current?.focus();
      } else if (key === 'escape' && cur) {
        setSpanRef.current(null);
        setTimeEditId(null);
        setWhenOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const onCommentsRef = useRef(onComments);
  onCommentsRef.current = onComments;

  const api = `/api/s/${token}/comments`;
  const apply = useCallback((c: ViewComment[]) => { setList(c); onCommentsRef.current(c); }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}?asset=${encodeURIComponent(assetId)}`, { cache: 'no-store' });
      const data = await res.json() as { comments?: ViewComment[]; error?: string };
      if (res.ok && data.comments) apply(data.comments);
    } catch { /* keep what we have */ }
  }, [api, assetId, apply]);

  useEffect(() => {
    setList(null); setError(null); setEditingId(null); setReplyingId(null); setTimeEditId(null); setWhenOpen(false);
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  /** Send a write; on "needs a name" ask once and retry. Returns true on success. */
  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    let name = getName();
    if (method === 'POST' && needsName && !name.trim()) {
      const given = await requestName();
      if (!given) return false;
      name = given;
    }
    try {
      const res = await fetch(api, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(method === 'POST' ? { ...body, asset: assetId, name } : body),
      });
      const data = await res.json() as { comments?: ViewComment[]; error?: string; needName?: boolean };
      if (!res.ok) {
        if (data.needName) {
          const given = await requestName();
          if (given) return send(method, body);
          return false;
        }
        setError(data.error ?? 'Something went wrong.');
        return false;
      }
      if (data.comments) apply(data.comments);
      return true;
    } catch {
      setError('Couldn’t reach the server. Try again.');
      return false;
    }
  }

  async function post() {
    if (timeEditId) {
      if (!span) return;
      setPosting(true);
      if (await send('PATCH', { id: timeEditId, timestamp: span.start, duration: spanDuration(span) })) endTimeEdit();
      setPosting(false);
      return;
    }
    const text = composeText.trim();
    if (!text) return;
    setPosting(true);
    if (await send('POST', { text, timestamp: span?.start ?? snapToFrame(getCurrentTime()), duration: span ? spanDuration(span) : null })) {
      setComposeText(''); setWhenOpen(false); onSpanChange(null);
    }
    setPosting(false);
  }
  function startTimeEdit(c: ViewComment) {
    if (c.timestamp === null) return;
    setTimeEditId(c.id);
    setEditingId(null);
    onSpanChange(spanOf(c.timestamp, c.duration));
    onSelect(c.id);
    openWhen(spanOf(c.timestamp, c.duration));
  }
  function endTimeEdit() {
    setTimeEditId(null);
    setWhenOpen(false);
    onSpanChange(null);
  }

  // ── The time chip's fields ──────────────────────────────────────────────────
  function syncFields(sp: CommentSpan | null) {
    const s0 = sp ?? { start: snapToFrame(getCurrentTime()), end: null };
    setInField(formatTimecode(s0.start));
    setOutField(formatTimecode(s0.end ?? s0.start));
    setBadField(null);
  }
  function openWhen(sp: CommentSpan | null = span) {
    onComposeFocus();
    const s0 = sp ?? { start: snapToFrame(getCurrentTime()), end: null };
    if (!sp) onSpanChange(s0);
    syncFields(s0);
    setWhenOpen(true);
  }
  // Keep the fields in step with the bar (handles dragged, I/O pressed) unless one is being typed in.
  useEffect(() => {
    if (!whenOpen) return;
    const el = document.activeElement as HTMLElement | null;
    if (el?.dataset.when === 'in' || el?.dataset.when === 'out') return;
    syncFields(span);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span?.start, span?.end, whenOpen]);
  function setKind(range: boolean) {
    const cur = span ?? { start: snapToFrame(getCurrentTime()), end: null };
    const next = range
      ? { start: cur.start, end: cur.end ?? snapToFrame(cur.start + 5) }
      : { start: cur.start, end: null };
    onSpanChange(next);
    syncFields(next);
  }
  function commitField(which: 'in' | 'out') {
    const t = parseTimecode(which === 'in' ? inField : outField);
    if (t === null) { setBadField(which); return; }
    setBadField(null);
    const cur = span ?? { start: snapToFrame(getCurrentTime()), end: null };
    const v = snapToFrame(t);
    let next: CommentSpan;
    if (which === 'in') {
      next = { start: v, end: cur.end !== null && cur.end <= v ? snapToFrame(v + 1) : cur.end };
    } else {
      next = { start: cur.start, end: Math.max(v, snapToFrame(cur.start + 1 / 24)) };
    }
    onSpanChange(next);
    syncFields(next);
  }
  function setNow(which: 'in' | 'out') {
    const t = snapToFrame(getCurrentTime());
    const cur = span ?? { start: t, end: null };
    const next = which === 'in'
      ? { start: t, end: cur.end !== null && cur.end <= t ? snapToFrame(t + 1) : cur.end }
      : (t <= cur.start ? cur : { start: cur.start, end: t });
    onSpanChange(next);
    syncFields(next);
  }
  async function saveEdit(id: string) {
    if (!editText.trim()) return;
    setBusyId(id);
    if (await send('PATCH', { id, text: editText.trim() })) { setEditingId(null); setEditText(''); }
    setBusyId(null);
  }
  async function reply(parentId: string) {
    if (!replyText.trim()) return;
    setBusyId(parentId);
    if (await send('POST', { text: replyText.trim(), parentId })) { setReplyingId(null); setReplyText(''); }
    setBusyId(null);
  }
  async function remove(id: string) {
    setBusyId(id);
    await send('DELETE', { id });
    setBusyId(null);
  }
  async function toggleComplete(c: ViewComment) {
    setBusyId(c.id);
    await send('PATCH', { id: c.id, completed: !c.completed });
    setBusyId(null);
  }

  const moderate = staff && !clientView;
  const all = threads((list ?? []).filter((c) => moderate || !c.internal || internalShare)).sort((a, b) => {
    if (sort === 'new') return b.createdAt.localeCompare(a.createdAt);
    if (a.timestamp === null || b.timestamp === null) return (a.timestamp === null ? 1 : 0) - (b.timestamp === null ? 1 : 0) || a.createdAt.localeCompare(b.createdAt);
    return a.timestamp - b.timestamp || a.createdAt.localeCompare(b.createdAt);
  });

  // A comment picked on the player's bar scrolls into view here.
  useEffect(() => {
    if (!selectedId) return;
    const card = listRef.current?.querySelector<HTMLElement>(`[data-cid="${CSS.escape(selectedId)}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);
  const pick = (c: ViewComment) => { if (c.timestamp !== null) onSelect(c.id); };
  const playingNow = (c: ViewComment) => c.timestamp !== null && playhead >= c.timestamp && playhead < c.timestamp + (c.duration || MOMENT_S);

  function header(c: ViewComment, top: boolean) {
    return (
      <div className="mad-comment-header">
        <div className="mad-comment-avatar mad-comment-avatar--placeholder">{(c.authorName || '?')[0].toUpperCase()}</div>
        <span className="mad-comment-author">{c.authorName}</span>
        {moderate && c.internal && !internalShare && top && (
          <span className="mad-comment-source mad-comment-source--internal" title="Staff only — never shown to clients">Internal</span>
        )}
        <div className="mad-comment-meta">
          <span className="mad-comment-meta-spacer" aria-hidden="true" />
          <span className="mad-comment-date">{formatCommentDate(c.createdAt)}</span>
        </div>
        {top && moderate && (
          <button type="button" className={`mad-comment-action mad-comment-check${c.completed ? ' mad-comment-check--done' : ''}`}
            onClick={() => void toggleComplete(c)} disabled={busyId === c.id}
            title={c.completed ? 'Mark incomplete' : 'Mark complete'} aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}>
            <IconCheck />
          </button>
        )}
        {c.canEdit && editingId !== c.id && (
          <button type="button" className="mad-comment-action" onClick={() => { setEditingId(c.id); setEditText(c.text); }} aria-label="Edit comment" title="Edit comment">
            <IconEdit />
          </button>
        )}
        {(c.canEdit || (c.canDelete && !clientView)) && (
          <button type="button" className="mad-comment-action mad-comment-action--danger" onClick={() => void remove(c.id)}
            disabled={busyId === c.id} aria-label="Delete comment" title="Delete comment">
            {busyId === c.id ? '…' : <IconTrash />}
          </button>
        )}
      </div>
    );
  }

  function body(c: ViewComment) {
    if (editingId !== c.id) return <p className="mad-comment-text">{c.text}</p>;
    return (
      <div className="mad-comment-edit">
        <textarea className="mad-comment-edit-input" value={editText} rows={2} autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit(c.id); }
            if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
          }} />
        <div className="mad-comment-edit-footer">
          <button type="button" className="mad-comment-trigger" onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
          <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void saveEdit(c.id)} disabled={!editText.trim() || busyId === c.id}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mad-comments-section">
      {list === null && <p className="mad-comments-empty">Loading…</p>}
      {list !== null && all.length === 0 && <p className="mad-comments-empty">No comments yet.</p>}

      {all.length > 1 && (
        <div className="mad-comments-sort">
          <select value={sort} onChange={(e) => chooseSort(e.target.value as SortKey)} aria-label="Sort comments">
            <option value="time">By time in video</option>
            <option value="new">Newest first</option>
          </select>
        </div>
      )}

      {all.length > 0 && (
        <div className="mad-comments-list" ref={listRef}>
          {all.map((c) => (
            <div key={c.id} data-cid={c.id}
              className={`mad-comment${c.completed ? ' mad-comment--done' : ''}${c.timestamp !== null ? ' mad-comment--seekable' : ''}${selectedId === c.id ? ' mad-comment--sel' : ''}${playingNow(c) ? ' mad-comment--now' : ''}`}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('button, input, textarea, select, a')) pick(c); }}>
              {header(c, true)}
              {/* Timecode / span on its own line so it never gets clipped. */}
              {c.timestamp !== null && (
                <button type="button" className="mad-comment-time mad-comment-time--seek mad-comment-when" title="Go to this comment" onClick={() => pick(c)}>
                  {formatTimecode(c.timestamp)}{c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}
                </button>
              )}
              {body(c)}
              {(c.replies.length > 0 || replyingId === c.id) && (
                <div className="mad-comment-replies">
                  {c.replies.map((r) => (
                    <div key={r.id} className="mad-comment-reply">
                      {header(r, false)}
                      {body(r)}
                    </div>
                  ))}
                  {replyingId === c.id && (
                    <div className="mad-reply-compose">
                      <input className="mad-reply-input" placeholder="Write a reply…" value={replyText} autoFocus
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void reply(c.id); }
                          if (e.key === 'Escape') { setReplyingId(null); setReplyText(''); }
                        }} />
                      <div className="mad-reply-actions">
                        <button type="button" className="mad-comment-trigger" onClick={() => { setReplyingId(null); setReplyText(''); }}>Cancel</button>
                        <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void reply(c.id)} disabled={busyId === c.id || !replyText.trim()}>
                          {busyId === c.id ? '…' : 'Reply'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {replyingId !== c.id && (
                <div className="mad-comment-foot">
                  <button type="button" className="mad-comment-trigger mad-reply-btn" onClick={() => { setReplyingId(c.id); setReplyText(''); }}>Reply</button>
                  {c.canEdit && c.timestamp !== null && timeEditId !== c.id && (
                    <button type="button" className="mad-comment-trigger mad-reply-btn" onClick={() => startTimeEdit(c)}>Edit time</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mad-comment-compose" ref={composeRef}>
        {timeEditId && (
          <div className="mad-compose-editing">
            <span>Moving your comment</span>
            <button type="button" className="mad-comment-trigger" onClick={endTimeEdit}>Cancel</button>
          </div>
        )}
        <div className="mad-compose-when-row">
          <div className="mad-compose-when-wrap">
            <button type="button" className={`mad-compose-when${span ? '' : ' mad-compose-when--following'}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (whenOpen ? setWhenOpen(false) : openWhen())}
              aria-haspopup="dialog" aria-expanded={whenOpen} title="Set the comment's time">
              @ {formatTimecode(span?.start ?? playhead)}
              {span?.end != null && <> → {formatTimecode(span.end)}</>}
            </button>
            {span && !timeEditId && (
              <button type="button" className="mad-compose-span-clear" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setWhenOpen(false); onSpanChange(null); }} aria-label="Discard comment time">×</button>
            )}
            {whenOpen && (
              <div className="mad-when-pop" role="dialog" aria-label="Comment time"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setWhenOpen(false); } }}>
                <div className="mad-when-kind" role="group" aria-label="Kind">
                  <button type="button" aria-pressed={!span || span.end === null} onClick={() => setKind(false)}>Point</button>
                  <button type="button" aria-pressed={!!span && span.end !== null} onClick={() => setKind(true)}>Range</button>
                </div>
                {(['in', 'out'] as const).filter((w) => w === 'in' || (span && span.end !== null)).map((w) => (
                  <label key={w} className="mad-when-field">
                    <span>{w === 'in' ? (span?.end != null ? 'In' : 'At') : 'Out'}</span>
                    <input data-when={w} className={badField === w ? 'is-bad' : ''} spellCheck={false} inputMode="numeric"
                      value={w === 'in' ? inField : outField}
                      onChange={(e) => (w === 'in' ? setInField(e.target.value) : setOutField(e.target.value))}
                      onFocus={(e) => { onComposeFocus(); e.currentTarget.select(); }}
                      onBlur={() => commitField(w)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitField(w); e.currentTarget.select(); } }} />
                    <button type="button" className="mad-when-now" onClick={() => setNow(w)} title="Set to the playhead">Now</button>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        {timeEditId ? (
          <div className="mad-comment-compose-row">
            <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void post()} disabled={posting || !span}>
              {posting ? '…' : 'Save time'}
            </button>
          </div>
        ) : (
        <div className="mad-comment-compose-row">
          <input
            ref={composeInputRef}
            className="mad-comment-compose-input"
            placeholder={internalShare ? 'Add an internal comment…' : 'Add a comment…'}
            value={composeText}
            onFocus={() => {
              onComposeFocus();
              // Keep a drafted point/range (I/O keys, drag); otherwise pin to the playhead.
              if (!span) onSpanChange({ start: snapToFrame(getCurrentTime()), end: null });
            }}
            onBlur={(e) => {
              // Leaving for the time chip keeps the draft; leaving the comment box with nothing written drops it.
              if (composeRef.current?.contains(e.relatedTarget as Node | null)) return;
              if (!composeText.trim()) { setWhenOpen(false); onSpanChange(null); }
            }}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void post(); }
              if (e.key === 'Escape') { setComposeText(''); setError(null); setWhenOpen(false); onSpanChange(null); (e.target as HTMLInputElement).blur(); }
            }}
          />
          <button type="button" className="mad-comment-compose-send" onClick={() => void post()} disabled={posting || !composeText.trim()} aria-label="Post comment">
            {posting ? '…' : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
            )}
          </button>
        </div>
        )}
        {error && <span className="mad-compose-err">{error}</span>}
      </div>
    </div>
  );
}
