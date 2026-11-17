'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type CommentSpan, type SpanEdge, snapToFrame, dragSpanEdge } from '@/lib/comment-span';
import { type BarMarker, buildClusters, stackRows } from '@/lib/review-bar';

/**
 * The player's review bar: a tall scrub track with an always-visible playhead,
 * a hover preview (thumbnail + timecode, plus the comment under the pointer),
 * and comment markers on a thin strip above it. Markers never take the
 * pointer, so a press anywhere scrubs. Markers too close to tell apart merge
 * into a count pill; hovering or tapping it opens a loupe that zooms into that
 * stretch for picking a comment, fine scrubbing, and placing a draft comment.
 * Ctrl/⌘-drag marks a range for a new comment.
 */

interface Props {
  duration: number;
  currentTime: number;
  buffered: number;
  playing: boolean;
  markers: BarMarker[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Time being drafted in the comment box; drawn with drag handles. */
  pendingSpan?: CommentSpan | null;
  onPendingSpanChange?: (span: CommentSpan) => void;
  /** A drag of the span's handles ended (save it, if it's a posted comment being moved). */
  onPendingSpanCommit?: () => void;
  /** Ctrl/⌘-drag finished marking a range. Omit to turn Ctrl/⌘-drag off. */
  onSpanMarked?: () => void;
  onSeek: (t: number) => void;
  onPause: () => void;
  onResume: () => void;
  /** True while the bar is in use (hovered, dragged, loupe open): keep the controls up. */
  onBusyChange?: (busy: boolean) => void;
  thumbnailUrl?: (t: number) => string;
  /** Nearest prefetched thumbnail time, used while the pointer is still moving. */
  nearestThumbTime?: (t: number) => number;
}

type Drag =
  | { kind: 'scrub'; map: (x: number) => number; was: boolean; moved: boolean }
  | { kind: 'edge'; edge: SpanEdge; map: (x: number) => number }
  | { kind: 'span'; anchor: number };

const FRAME = 1 / 24;
const THUMB_HALF_W = 80;
const THUMB_SETTLE_MS = 150;
const NOTE_PX = 6;
const LOUPE_MAX_W = 280;
const LOUPE_PAD = 12;
const CHIP_PX = 22;
const OPEN_MS = 120;
const CLOSE_MS = 250;

/** MM:SS:FF at 24 fps */
function fmtTc(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00:00';
  const m = Math.floor(s / 60), sc = Math.floor(s % 60), fr = Math.floor((s % 1) * 24);
  return `${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}
/** M:SS */
function fmtShort(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

export function ReviewBar({
  duration, currentTime, buffered, playing, markers, selectedId = null, onSelect,
  pendingSpan = null, onPendingSpanChange, onPendingSpanCommit, onSpanMarked, onSeek, onPause, onResume, onBusyChange,
  thumbnailUrl, nearestThumbTime,
}: Readonly<Props>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const loupeTrackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const spanRef = useRef(pendingSpan);
  spanRef.current = pendingSpan;

  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null); // time under a drag
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const [spanMode, setSpanMode] = useState(false);
  const [exact, setExact] = useState(false);
  const [loupe, setLoupe] = useState<{ key: string; auto: boolean } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const pct = (t: number) => (duration > 0 ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0);
  const clamp = (t: number) => Math.max(0, Math.min(duration, t));
  const byId = useMemo(() => new Map(markers.map((m) => [m.id, m])), [markers]);
  const clusters = useMemo(() => buildClusters(markers, duration, width), [markers, duration, width]);
  const cluster = loupe ? clusters.find((k) => k.key === loupe.key && k.ids.length > 1) ?? null : null;

  // The group a draft comment's time falls in: the loupe opens on its own while you write there.
  const draftStart = pendingSpan?.start ?? null;
  const autoKey = useMemo(() => {
    if (draftStart === null) return null;
    return clusters.find((k) => k.ids.length > 1 && draftStart >= k.lo && draftStart <= k.hi)?.key ?? null;
  }, [clusters, draftStart]);
  const autoKeyRef = useRef(autoKey);
  autoKeyRef.current = autoKey;
  useEffect(() => {
    if (dragging) return;
    setLoupe((cur) => {
      if (autoKey && !cur) return { key: autoKey, auto: true };
      if (cur?.auto && autoKey !== cur.key) return autoKey ? { key: autoKey, auto: true } : null;
      return cur;
    });
  }, [autoKey, dragging]);

  const busy = over || dragging || !!cluster;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  // ── loupe open / close ──────────────────────────────────────────────────────
  function keepOpen() {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }
  function scheduleOpen(key: string) {
    keepOpen();
    if (loupe?.key === key || openTimer.current) return;
    openTimer.current = setTimeout(() => { openTimer.current = null; setLoupe({ key, auto: false }); }, OPEN_MS);
  }
  function scheduleClose() {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (!loupe || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (dragRef.current) return;
      const ak = autoKeyRef.current;
      setLoupe(ak ? { key: ak, auto: true } : null);
    }, CLOSE_MS);
  }

  // ── pointer → time ──────────────────────────────────────────────────────────
  function xToT(x: number): number {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return clamp(((x - r.left) / r.width) * duration);
  }
  function loupeT(x: number): number {
    const r = loupeTrackRef.current?.getBoundingClientRect();
    if (!cluster || !r || !r.width) return xToT(x);
    return cluster.lo + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (cluster.hi - cluster.lo);
  }

  function startDrag(e: React.PointerEvent<HTMLDivElement>, d: Drag, t: number) {
    dragRef.current = d;
    setDragging(true);
    setShown(t);
    setHover(null);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  function beginScrub(e: React.PointerEvent<HTMLDivElement>, map: (x: number) => number) {
    const t = map(e.clientX);
    startDrag(e, { kind: 'scrub', map, was: playing, moved: false }, t);
    onSeek(t);
  }
  function beginEdge(e: React.PointerEvent<HTMLDivElement>, edge: SpanEdge, map: (x: number) => number) {
    const span = spanRef.current;
    if (!span || !onPendingSpanChange) return;
    onPause();
    startDrag(e, { kind: 'edge', edge, map }, edge === 'end' && span.end !== null ? span.end : span.start);
  }

  function handleDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!duration || e.button > 0) return;
    // Keep keyboard focus where it is (a comment being written stays focused).
    e.preventDefault();
    e.stopPropagation();
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.rb-loupe')) {
      keepOpen();
      const chip = tgt.closest<HTMLElement>('.rb-mk');
      if (chip?.dataset.id) { onSelect?.(chip.dataset.id); return; }
      const grip = tgt.closest<HTMLElement>('.rb-grip');
      if (grip) { beginEdge(e, grip.dataset.edge as SpanEdge, loupeT); return; }
      if (tgt.closest('.rb-lp-track, .rb-lp-lane')) beginScrub(e, loupeT);
      return;
    }
    const pill = tgt.closest<HTMLElement>('.rb-clu');
    if (pill?.dataset.k) { keepOpen(); setLoupe({ key: pill.dataset.k, auto: false }); return; }
    const grip = tgt.closest<HTMLElement>('.rb-grip');
    if (grip) { beginEdge(e, grip.dataset.edge as SpanEdge, xToT); return; }
    if ((e.ctrlKey || e.metaKey) && onSpanMarked && onPendingSpanChange) {
      const t = snapToFrame(xToT(e.clientX));
      onPause();
      onPendingSpanChange({ start: t, end: null });
      onSeek(t);
      startDrag(e, { kind: 'span', anchor: t }, t);
      return;
    }
    beginScrub(e, xToT);
  }

  function handleMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) {
      setSpanMode(!!onSpanMarked && (e.ctrlKey || e.metaKey));
      const tgt = e.target as HTMLElement;
      const pill = tgt.closest<HTMLElement>('.rb-clu');
      const inLoupe = tgt.closest('.rb-loupe');
      if (pill?.dataset.k) scheduleOpen(pill.dataset.k);
      else if (inLoupe) keepOpen();
      else scheduleClose();
      setHover(pill || inLoupe ? null : xToT(e.clientX));
      return;
    }
    if (e.buttons === 0) { endDrag(e); return; }
    if (d.kind === 'span') {
      const st = snapToFrame(xToT(e.clientX));
      const a = Math.min(d.anchor, st), b = Math.max(d.anchor, st);
      onPendingSpanChange?.({ start: a, end: b - a >= FRAME ? b : null });
      onSeek(st); setShown(st);
      return;
    }
    const t = d.map(e.clientX);
    if (d.kind === 'scrub') {
      if (!d.moved) { d.moved = true; onPause(); }
      onSeek(t); setShown(t);
      return;
    }
    const span = spanRef.current;
    if (!span || !onPendingSpanChange) return;
    const next = span.end === null ? { start: snapToFrame(clamp(t)), end: null } : dragSpanEdge(span, d.edge, t, duration);
    const at = d.edge === 'start' || next.end === null ? next.start : next.end;
    onPendingSpanChange(next);
    onSeek(at); setShown(at);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setDragging(false);
    setShown(null);
    if (d.kind === 'scrub' && d.moved && d.was) onResume();
    if (d.kind === 'span') onSpanMarked?.();
    if (d.kind === 'edge') onPendingSpanCommit?.();
  }

  // ── hover preview ───────────────────────────────────────────────────────────
  const tipT = dragging ? shown : hover;
  useEffect(() => {
    if (tipT === null) return;
    setExact(false);
    const id = setTimeout(() => setExact(true), THUMB_SETTLE_MS);
    return () => clearTimeout(id);
  }, [tipT]);
  const note = !dragging && tipT !== null && width > 0
    ? markers.find((m) => m.timestamp !== null && (Math.abs(m.timestamp - tipT) / duration) * width < NOTE_PX) ?? null
    : null;
  const tipX = tipT === null ? 0 : (pct(tipT) / 100) * width;
  const tipLeft = Math.max(THUMB_HALF_W, Math.min(width - THUMB_HALF_W, tipX));

  // ── loupe layout ────────────────────────────────────────────────────────────
  const loupeW = Math.max(120, Math.min(LOUPE_MAX_W, width - 8));
  const loupeView = cluster && (() => {
    const lp = (t: number) => ((t - cluster.lo) / (cluster.hi - cluster.lo)) * 100;
    const items = cluster.ids.map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => a.timestamp! - b.timestamp!);
    const chipPct = (CHIP_PX / (loupeW - LOUPE_PAD * 2)) * 100;
    const { rows, count } = stackRows(items.map((m) => ({
      startPct: lp(m.timestamp!), endPct: lp(m.timestamp! + (m.duration ?? 0)),
    })), chipPct);
    const span = pendingSpan;
    const a = span?.start ?? 0, b = span?.end ?? a;
    const draftVis = !!span && b >= cluster.lo && a <= cluster.hi;
    return { lp, items, rows, count, span, a, b, draftVis };
  })();

  const left = Math.min(width - loupeW / 2, Math.max(loupeW / 2, cluster ? (cluster.x / 100) * width : 0));
  const head = pct(currentTime);

  return (
    <div
      ref={rootRef}
      className={`rb${spanMode ? ' rb--span' : ''}${dragging ? ' rb--drag' : ''}`}
      style={{ touchAction: 'none' }}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => { setOver(false); setSpanMode(false); if (!dragRef.current) { setHover(null); scheduleClose(); } }}
      onContextMenu={(e) => { if (onSpanMarked) e.preventDefault(); }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="rb-lane" aria-hidden>
        {markers.map((m) => m.timestamp !== null && m.duration ? (
          <span key={m.id} className={`rb-span${m.completed ? ' rb--done' : ''}${selectedId === m.id ? ' rb--sel' : ''}`}
            style={{ left: `${pct(m.timestamp)}%`, width: `${pct(m.timestamp + m.duration) - pct(m.timestamp)}%` }} />
        ) : null)}
        {clusters.map((k) => {
          if (k.ids.length === 1) {
            const m = byId.get(k.ids[0])!;
            return <span key={k.key} className={`rb-tick${m.completed ? ' rb--done' : ''}${selectedId === m.id ? ' rb--sel' : ''}`} style={{ left: `${pct(m.timestamp!)}%` }} />;
          }
          return null;
        })}
      </div>
      {clusters.filter((k) => k.ids.length > 1).map((k) => (
        <button key={k.key} type="button" tabIndex={-1}
          className={`rb-clu${cluster?.key === k.key ? ' rb-clu--open' : ''}${selectedId && k.ids.includes(selectedId) ? ' rb--sel' : ''}`}
          style={{ left: `${k.x}%` }}
          aria-label={`${k.ids.length} comments between ${fmtShort(k.lo)} and ${fmtShort(k.hi)}`}>
          {k.ids.length}
        </button>
      ))}

      <div ref={trackRef} className="rb-track">
        <div className="rb-buffered" style={{ width: `${pct(buffered)}%` }} />
        <div className="rb-fill" style={{ width: `${head}%` }} />
        {pendingSpan && (
          <>
            <div className={`rb-pend${pendingSpan.end === null ? ' rb-pend--point' : ''}`}
              style={{ left: `${pct(pendingSpan.start)}%`, width: pendingSpan.end === null ? undefined : `${pct(pendingSpan.end) - pct(pendingSpan.start)}%` }} />
            {onPendingSpanChange && <span className="rb-grip" data-edge="start" style={{ left: `${pct(pendingSpan.start)}%` }} aria-label="Comment start" />}
            {onPendingSpanChange && pendingSpan.end !== null && <span className="rb-grip" data-edge="end" style={{ left: `${pct(pendingSpan.end)}%` }} aria-label="Comment end" />}
          </>
        )}
        <div className="rb-knob" style={{ left: `${head}%` }} />
      </div>

      {tipT !== null && <div className="rb-ghost" style={{ left: `${pct(tipT)}%` }} />}
      {tipT !== null && !cluster && (
        <div className="rb-tip" style={{ left: tipLeft }} aria-hidden>
          {thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="rb-thumb" alt=""
              src={thumbnailUrl(exact || !nearestThumbTime ? tipT : nearestThumbTime(tipT))}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              onLoad={(e) => { e.currentTarget.style.display = 'block'; }} />
          )}
          <span className="rb-tiptc">{fmtTc(tipT)}</span>
          {note && <span className="rb-tipnote">{note.authorName}: {note.text}</span>}
        </div>
      )}

      {cluster && loupeView && (
        <div className="rb-loupe" style={{ left, width: loupeW }}>
          <div className="rb-lp-h">
            <span>{fmtShort(cluster.lo)} – {fmtShort(cluster.hi)}</span>
            <span>{cluster.ids.length} comments</span>
          </div>
          <div className="rb-lp-body">
            <div className="rb-lp-lane" style={{ height: loupeView.count * CHIP_PX - 4 }}>
              {loupeView.items.map((m, i) => {
                const s = loupeView.lp(m.timestamp!);
                const w = m.duration ? Math.min(100, loupeView.lp(m.timestamp! + m.duration)) - s : 0;
                const label = `${m.authorName} at ${fmtTc(m.timestamp!)}: ${m.text}`;
                return (
                  <button key={m.id} type="button" tabIndex={-1} title={label} aria-label={label}
                    className={`rb-mk${selectedId === m.id ? ' rb--sel' : ''}${m.completed ? ' rb--done' : ''}`}
                    style={{ left: `${s}%`, width: `${w}%`, top: loupeView.rows[i] * CHIP_PX }}>
                    {m.duration ? <span className="rb-mk-bar" /> : null}
                    <span className="rb-mk-chip">{initial(m.authorName)}</span>
                  </button>
                );
              })}
            </div>
            <div ref={loupeTrackRef} className="rb-lp-track">
              <div className="rb-lp-fill" style={{ width: `${Math.max(0, Math.min(100, loupeView.lp(currentTime)))}%` }} />
              {loupeView.draftVis && (
                <>
                  <div className={`rb-pend${loupeView.span!.end === null ? ' rb-pend--point' : ''}`}
                    style={{
                      left: `${Math.max(0, loupeView.lp(loupeView.a))}%`,
                      width: loupeView.span!.end === null ? undefined : `${Math.min(100, loupeView.lp(loupeView.b)) - Math.max(0, loupeView.lp(loupeView.a))}%`,
                    }} />
                  {loupeView.a >= cluster.lo && <span className="rb-grip" data-edge="start" style={{ left: `${loupeView.lp(loupeView.a)}%` }} />}
                  {loupeView.span!.end !== null && loupeView.b <= cluster.hi && <span className="rb-grip" data-edge="end" style={{ left: `${loupeView.lp(loupeView.b)}%` }} />}
                </>
              )}
            </div>
            {currentTime >= cluster.lo && currentTime <= cluster.hi && (
              <div className="rb-lp-head" style={{ left: `${loupeView.lp(currentTime)}%` }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
