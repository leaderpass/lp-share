'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHlsPlayer } from '@/hooks/useHlsPlayer';
import { formatTimecode } from '@/lib/format';

/**
 * The share player — LPOS's MediaPlayer (compact variant) ported for LP Share:
 * Cloudflare HLS, comment ticks/ranges on the scrub bar, scrub thumbnails from
 * Cloudflare, hold-right-half-to-speed-up, quality toggle, fullscreen.
 * (LPOS's theater mode and in-player comment panel are not part of this app.)
 */

export interface PlayerMarker {
  id: string;
  timestamp: number | null;
  duration: number | null;
  completed: boolean;
  authorName: string;
  text: string;
}

interface Props {
  /** Cloudflare HLS manifest URL. */
  src: string;
  markers?: PlayerMarker[];
  seekTarget?: number | null;
  onSeekHandled?: () => void;
  onCurrentTimeChange?: (t: number) => void;
}

const SPEED_LEVELS = [1, 1.25, 1.5, 2] as const;
const SPEED_LOCK_PX = 25;
const SPEED_HOLD_MS = 200;
const THUMB_TARGET_S = 2.5;
const THUMB_GRID_CAP = 60;
const THUMB_GRID_MIN = 8;
const THUMB_SETTLE_MS = 150;
const THUMB_HALF_W = 80;

/** MM:SS:FF at 24 fps */
function fmtTc(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00:00';
  const m = Math.floor(s / 60), sc = Math.floor(s % 60), fr = Math.floor((s % 1) * 24);
  return `${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

/** Cloudflare frame at time t, from the manifest URL's video base. */
function cfThumb(hlsUrl: string, t: number): string {
  const base = hlsUrl.replace(/\/manifest\/video\.m3u8.*$/, '');
  return `${base}/thumbnails/thumbnail.jpg?time=${Math.max(0, Math.round(t))}s&height=180`;
}

export function Player({ src, markers = [], seekTarget, onSeekHandled, onCurrentTimeChange }: Readonly<Props>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedLevelRef = useRef(0);
  const speedStartYRef = useRef(0);
  const speedLockedRef = useRef(false);
  const draggingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const movedRef = useRef(false);
  const speedGestureRef = useRef(false);
  const gridTimesRef = useRef<number[]>([]);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const [scrubPreview, setScrubPreview] = useState<{ t: number; x: number } | null>(null);
  const [scrubExact, setScrubExact] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [volHover, setVolHover] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [speedLocked, setSpeedLocked] = useState(false);
  const [speedHolding, setSpeedHolding] = useState(false);
  const [rightHover, setRightHover] = useState(false);
  const [ctrlsVisible, setCtrlsVisible] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false); setPlaying(false); setCurrentTime(0); setDuration(0); setVideoAspect(null);
    gridTimesRef.current = [];
  }, [src]);

  const quality = useHlsPlayer(videoRef, src);
  const thumbnailUrl = useCallback((t: number) => cfThumb(src, t), [src]);

  // Prefetch a thumbnail grid once duration is known (probe one first; skip on 404).
  useEffect(() => {
    if (!duration || duration <= 0) return;
    const n = Math.max(THUMB_GRID_MIN, Math.min(THUMB_GRID_CAP, Math.ceil(duration / THUMB_TARGET_S)));
    const times = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * duration));
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (cancelled) return;
      gridTimesRef.current = times;
      for (const t of times) { const img = new Image(); img.src = thumbnailUrl(t); }
    };
    probe.onerror = () => { if (!cancelled) gridTimesRef.current = []; };
    probe.src = thumbnailUrl(times[Math.floor(n / 2)]);
    return () => { cancelled = true; };
  }, [duration, thumbnailUrl]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setCtrlsVisible(false), 1000);
  }, []);
  const showControls = useCallback(() => { setCtrlsVisible(true); scheduleHide(); }, [scheduleHide]);

  function handleContainerMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    showControls();
    const el = containerRef.current;
    if (!el) return;
    const overVideo = (e.target as HTMLElement).closest('.mp-video-area');
    const rect = el.getBoundingClientRect();
    setRightHover(!!overVideo && e.clientX > rect.left + rect.width * 0.5);
  }

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [scheduleHide]);

  useEffect(() => () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (speedTimerRef.current) clearInterval(speedTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  useEffect(() => {
    if (seekTarget == null) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekTarget;
    void v.play();
    onSeekHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTarget]);

  // ── Scrub bar ───────────────────────────────────────────────────────────────
  function scrubTimeFromX(clientX: number): number | null {
    const el = scrubRef.current;
    if (!el || !duration) return null;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  }
  function scrubPreviewX(clientX: number): number {
    const el = scrubRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(THUMB_HALF_W, Math.min(rect.width - THUMB_HALF_W, clientX - rect.left));
  }
  function nearestGridTime(t: number): number {
    const grid = gridTimesRef.current;
    if (!grid.length) return t;
    let best = grid[0], bestD = Math.abs(t - best);
    for (let i = 1; i < grid.length; i += 1) { const d = Math.abs(t - grid[i]); if (d < bestD) { bestD = d; best = grid[i]; } }
    return best;
  }
  function scheduleSettle() {
    setScrubExact(false);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setScrubExact(true), THUMB_SETTLE_MS);
  }
  function endScrubPreview() {
    setScrubPreview(null); setScrubExact(false);
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
  }
  function handleScrubPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v || !duration) return;
    const cls = (e.target as HTMLElement).classList;
    if (cls.contains('mp-tick') || cls.contains('mp-range')) return;
    e.stopPropagation();
    const t = scrubTimeFromX(e.clientX);
    if (t === null) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    draggingRef.current = true;
    wasPlayingRef.current = !v.paused && !v.ended;
    movedRef.current = false;
    v.currentTime = t;
    setCurrentTime(t);
    setScrubPreview({ t, x: scrubPreviewX(e.clientX) });
    scheduleSettle();
  }
  function handleScrubPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    if (e.buttons === 0) {   // a missed pointer-up left capture stuck — release it
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      draggingRef.current = false;
      endScrubPreview();
      return;
    }
    const v = videoRef.current;
    if (!v || !duration) return;
    const t = scrubTimeFromX(e.clientX);
    if (t === null) return;
    if (!movedRef.current) { movedRef.current = true; if (!v.paused) v.pause(); }
    v.currentTime = t;
    setCurrentTime(t);
    setScrubPreview({ t, x: scrubPreviewX(e.clientX) });
    scheduleSettle();
  }
  function endScrubDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    draggingRef.current = false;
    endScrubPreview();
    const v = videoRef.current;
    if (!v) return;
    if (!movedRef.current || wasPlayingRef.current) void v.play();
    movedRef.current = false;
  }
  function seekTo(ts: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ts;
    void v.play();
  }

  // ── Speed hold (press and hold the right half) ──────────────────────────────
  function beginSpeedHold() {
    holdTimerRef.current = null;
    speedLockedRef.current = false;
    speedLevelRef.current = 1;
    speedGestureRef.current = true;
    const first = SPEED_LEVELS[1];
    setSpeed(first); setSpeedHolding(true);
    if (videoRef.current) videoRef.current.playbackRate = first;
    if (speedTimerRef.current) clearInterval(speedTimerRef.current);
    speedTimerRef.current = setInterval(() => {
      speedLevelRef.current = Math.min(speedLevelRef.current + 1, SPEED_LEVELS.length - 1);
      const s = SPEED_LEVELS[speedLevelRef.current];
      setSpeed(s);
      if (videoRef.current) videoRef.current.playbackRate = s;
    }, 1500);
  }
  function handleContainerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = containerRef.current;
    if (!el || !(e.target as HTMLElement).closest('.mp-video-area')) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width * 0.5) return;
    speedStartYRef.current = e.clientY;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(beginSpeedHold, SPEED_HOLD_MS);
  }
  function handleContainerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!speedTimerRef.current && !speedLockedRef.current) return;
    if (!speedLockedRef.current && e.clientY - speedStartYRef.current > SPEED_LOCK_PX) {
      speedLockedRef.current = true;
      setSpeedLocked(true);
      if (speedTimerRef.current) { clearInterval(speedTimerRef.current); speedTimerRef.current = null; }
    }
  }
  function handleContainerPointerUp() {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; return; }
    if (!speedTimerRef.current) return;
    clearInterval(speedTimerRef.current);
    speedTimerRef.current = null;
    setSpeedHolding(false);
    if (!speedLockedRef.current) {
      setSpeed(1); setSpeedLocked(false);
      if (videoRef.current) videoRef.current.playbackRate = 1;
    }
  }
  function clearLockedSpeed() {
    setSpeed(1); setSpeedLocked(false); setSpeedHolding(false);
    speedLockedRef.current = false;
    if (videoRef.current) videoRef.current.playbackRate = 1;
  }

  function handleVolumeChange(val: number) {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val; v.muted = val === 0;
    setVolume(val); setMuted(val === 0);
  }
  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) void containerRef.current?.requestFullscreen();
    else void document.exitFullscreen();
  }
  function handleProgress() {
    const v = videoRef.current;
    if (!v || !v.buffered.length) return;
    setBuffered(v.buffered.end(v.buffered.length - 1));
  }

  const timed = markers.filter((c) => c.timestamp !== null);

  return (
    <div
      ref={containerRef}
      className="mp-root mp-root--compact"
      style={videoAspect ? { aspectRatio: String(videoAspect) } : undefined}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={() => setRightHover(false)}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onPointerCancel={handleContainerPointerUp}
    >
      <div
        className="mp-video-area"
        onClick={() => {
          if (speedGestureRef.current) { speedGestureRef.current = false; return; }
          const v = videoRef.current;
          if (v) { if (v.paused) void v.play(); else v.pause(); }
        }}
      >
        <video
          ref={videoRef}
          className="mp-video"
          preload="metadata"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => { const t = videoRef.current?.currentTime ?? 0; setCurrentTime(t); onCurrentTimeChange?.(t); }}
          onProgress={handleProgress}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            setDuration(v?.duration ?? 0);
            const w = v?.videoWidth ?? 0, h = v?.videoHeight ?? 0;
            if (w > 0 && h > 0) setVideoAspect(w / h);
          }}
          onResize={() => {
            const v = videoRef.current;
            const w = v?.videoWidth ?? 0, h = v?.videoHeight ?? 0;
            if (w > 0 && h > 0) setVideoAspect(w / h);
          }}
          onError={() => setUnavailable(true)}
        />
        {!playing && !unavailable && currentTime === 0 && (
          <span className="mp-bigplay" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4" /></svg>
          </span>
        )}
        {unavailable && (
          <div className="mp-error-overlay">
            <span className="mp-error-title">Check back shortly</span>
            <span className="mp-error-sub">This video is still processing.</span>
          </div>
        )}
      </div>

      {speedLocked && speed > 1 && (
        <button type="button" className="mp-speed-badge" onClick={(e) => { e.stopPropagation(); clearLockedSpeed(); }}>
          {speed}× — tap to clear
        </button>
      )}

      {(rightHover || speedHolding) && !speedLocked && (
        <div className={`mp-speed-zone${speedHolding ? ' mp-speed-zone--holding' : ''}`} aria-hidden>
          {speedHolding ? (
            <>
              <span className="mp-speed-zone-rate">{speed}×</span>
              <div className="mp-lock-hint">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
                <span>↓ drag to lock</span>
              </div>
            </>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><polygon points="13 19 22 12 13 5 13 19" /><polygon points="2 19 11 12 2 5 2 19" /></svg>
          )}
        </div>
      )}

      <div className={`mp-controls-bar${ctrlsVisible ? ' mp-controls-bar--visible' : ''}`}>
        <div
          ref={scrubRef}
          className="mp-scrub"
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={endScrubDrag}
          onPointerCancel={endScrubDrag}
          style={{ touchAction: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mp-scrub-track">
            <div className="mp-scrub-buffered" style={{ width: duration ? `${(buffered / duration) * 100}%` : '0%' }} />
            <div className="mp-scrub-fill" style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
            <div className="mp-scrub-head" style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
            {duration > 0 && timed.map((c) => {
              const pct = ((c.timestamp ?? 0) / duration) * 100;
              const tip = `${formatTimecode(c.timestamp ?? 0)}${c.duration ? ` → ${formatTimecode((c.timestamp ?? 0) + c.duration)}` : ''} — ${c.authorName}: ${c.text}`;
              return c.duration && c.duration > 0 ? (
                <button key={c.id} type="button" className={`mp-range${c.completed ? ' mp-range--done' : ''}`}
                  style={{ left: `${pct}%`, width: `${(c.duration / duration) * 100}%` }} title={tip}
                  onClick={(e) => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                  aria-label={`Comment range at ${formatTimecode(c.timestamp ?? 0)}`} />
              ) : (
                <button key={c.id} type="button" className={`mp-tick${c.completed ? ' mp-tick--done' : ''}`}
                  style={{ left: `${pct}%` }} title={tip}
                  onClick={(e) => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                  aria-label={`Comment at ${formatTimecode(c.timestamp ?? 0)}`} />
              );
            })}
          </div>
          {scrubPreview && (
            <div className="mp-scrub-thumb-wrap" style={{ left: scrubPreview.x }} aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="mp-scrub-thumb"
                src={thumbnailUrl(scrubExact ? scrubPreview.t : nearestGridTime(scrubPreview.t))}
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                onLoad={(e) => { e.currentTarget.style.display = 'block'; }}
              />
              <span className="mp-scrub-thumb-tc">{fmtTc(scrubPreview.t)}</span>
            </div>
          )}
        </div>

        <div className="mp-btn-row">
          <button type="button" className="mp-btn"
            onClick={(e) => { e.stopPropagation(); const v = videoRef.current; if (v) { if (v.paused) void v.play(); else v.pause(); } }}
            aria-label={playing ? 'Pause' : 'Play'}>
            {playing
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>}
          </button>
          <div className="mp-spacer" />
          <div className="mp-timecode" aria-live="off">{fmtTc(currentTime)} / {fmtTc(duration)}</div>
          <div className="mp-spacer" />
          <div className={`mp-vol-wrap${volHover ? ' mp-vol-wrap--open' : ''}`}
            onMouseEnter={() => setVolHover(true)} onMouseLeave={() => setVolHover(false)}>
            <div className="mp-vol-slider-wrap" onClick={(e) => e.stopPropagation()}>
              <input type="range" min="0" max="1" step="0.02" value={muted ? 0 : volume} className="mp-vol-slider"
                style={{ background: (() => { const p = (muted ? 0 : volume) * 100; return p === 0 ? 'transparent' : `linear-gradient(to right, #fff ${p}%, rgba(255,255,255,0.25) ${p}% 100%)`; })() }}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))} aria-label="Volume" />
            </div>
            <button type="button" className="mp-btn" onClick={(e) => { e.stopPropagation(); toggleMute(); }} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></svg>}
            </button>
          </div>
          {quality.hasLevels && (
            <button type="button" className={`mp-btn mp-quality${quality.mode === 'max' ? ' mp-quality--on' : ''}`}
              onClick={(e) => { e.stopPropagation(); quality.setMode(quality.mode === 'max' ? 'auto' : 'max'); }}
              title={quality.mode === 'max' ? 'Full resolution — tap for Auto' : 'Auto quality — tap for full resolution'}>
              {quality.mode === 'max' ? 'HD' : 'AUTO'}
            </button>
          )}
          <button type="button" className="mp-btn" onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} aria-label="Fullscreen">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
