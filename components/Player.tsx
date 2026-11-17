'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHlsPlayer } from '@/hooks/useHlsPlayer';
import { type CommentSpan } from '@/lib/comment-span';
import { type BarMarker } from '@/lib/review-bar';
import { ReviewBar } from './ReviewBar';

/**
 * The share player — LPOS's MediaPlayer (compact variant) ported for LP Share:
 * Cloudflare HLS, the review bar (components/ReviewBar.tsx) with hover
 * thumbnails from Cloudflare, hold-right-half-to-speed-up, speed + shortcut
 * menus, quality toggle, fullscreen, and keyboard control.
 * (LPOS's theater mode and in-player comment panel are not part of this app.)
 */

export type PlayerMarker = BarMarker;

/** Jump the player to `t`; `play` false leaves it paused there (picking a comment). */
export interface SeekRequest { t: number; play: boolean }

interface Props {
  /** Cloudflare HLS manifest URL. */
  src: string;
  markers?: PlayerMarker[];
  seekTarget?: SeekRequest | null;
  onSeekHandled?: () => void;
  onCurrentTimeChange?: (t: number) => void;
  /** Span the compose box is drafting; drawn on the scrub bar with draggable edges. */
  pendingSpan?: CommentSpan | null;
  onPendingSpanChange?: (span: CommentSpan) => void;
  /** Bump to pause playback (e.g. the compose box took focus). */
  pauseSignal?: number;
  /** The comment picked on the bar or in the list (highlighted on the bar). */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Ctrl/⌘-drag marked a range: focus the comment box. Omit to turn it off. */
  onSpanMarked?: () => void;
}

const RATE_OPTIONS = [0.5, 1, 1.5, 2] as const; // speed menu
const SPEED_LOCK_PX = 25;
const SPEED_HOLD_MS = 200;
const THUMB_TARGET_S = 2.5;
const THUMB_GRID_CAP = 60;
const THUMB_GRID_MIN = 8;
const FRAME = 1 / 24;
const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← →', 'Back / forward one frame'],
  ['Shift ← →', 'Back / forward one second'],
  ['I', 'Comment starts here'],
  ['O', 'Comment ends here'],
  ['Ctrl/⌘ drag', 'Mark a range on the bar'],
  ['Esc', 'Clear the comment time'],
];

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

export function Player({ src, markers = [], seekTarget, onSeekHandled, onCurrentTimeChange, pendingSpan = null, onPendingSpanChange, pauseSignal, selectedId = null, onSelect, onSpanMarked }: Readonly<Props>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedLevelRef = useRef(0);
  const holdLevelsRef = useRef<number[]>([]);
  const speedStartYRef = useRef(0);
  const speedLockedRef = useRef(false);
  const speedGestureRef = useRef(false);
  const gridTimesRef = useRef<number[]>([]);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [volHover, setVolHover] = useState(false);
  const [holdRate, setHoldRate] = useState<number | null>(null); // live speed during a hold
  const [speedLocked, setSpeedLocked] = useState(false);
  const [speedHolding, setSpeedHolding] = useState(false);
  // Speed picked from the menu; a hold/lock gesture overrides it and falls back to it.
  const [rate, setRate] = useState(1);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const rateRef = useRef(1);
  const rateMenuRef = useRef<HTMLDivElement>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const keysMenuRef = useRef<HTMLDivElement>(null);
  const [barBusy, setBarBusy] = useState(false);
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
  }, []);

  useEffect(() => {
    if (seekTarget == null) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekTarget.t;
    setCurrentTime(seekTarget.t);
    if (seekTarget.play) void v.play(); else v.pause();
    onSeekHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTarget]);

  useEffect(() => {
    if (!pauseSignal) return;
    videoRef.current?.pause();
  }, [pauseSignal]);

  // ── Review bar ──────────────────────────────────────────────────────────────
  function nearestGridTime(t: number): number {
    const grid = gridTimesRef.current;
    if (!grid.length) return t;
    let best = grid[0], bestD = Math.abs(t - best);
    for (let i = 1; i < grid.length; i += 1) { const d = Math.abs(t - grid[i]); if (d < bestD) { bestD = d; best = grid[i]; } }
    return best;
  }
  function seekBar(t: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrentTime(t);
    onCurrentTimeChange?.(t);
  }
  function togglePlay() {
    const v = videoRef.current;
    if (v) { if (v.paused) void v.play(); else v.pause(); }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // Space plays/pauses; ← → step a frame, Shift ← → a second. (I / O / Esc for
  // the comment's time live with the comment box.) Ignored while typing.
  const durationRef = useRef(0);
  durationRef.current = duration;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && (rateMenuOpen || keysOpen)) { setRateMenuOpen(false); setKeysOpen(false); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (el?.tagName === 'BUTTON' || el?.getAttribute('role') === 'button') return; // let the focused button act
        e.preventDefault();
        if (v.paused) void v.play(); else v.pause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        v.pause();
        const step = (e.shiftKey ? 1 : FRAME) * (e.key === 'ArrowLeft' ? -1 : 1);
        const t = Math.max(0, Math.min(durationRef.current || Infinity, v.currentTime + step));
        v.currentTime = t;
        setCurrentTime(t);
        onCurrentTimeChange?.(t);
        showControls();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateMenuOpen, keysOpen]);

  // ── Speed hold (press and hold the right half) ──────────────────────────────
  // One speed: `rate` is what the menu shows and playback rests at. A hold
  // steps up through the menu speeds above it (never slower) and falls back to
  // it on release; locking a hold (drag down) makes that speed the new `rate`.
  function setRateTo(r: number) {
    rateRef.current = r;
    setRate(r);
    const v = videoRef.current;
    if (v) { v.defaultPlaybackRate = r; v.playbackRate = r; }
  }
  function beginSpeedHold() {
    holdTimerRef.current = null;
    speedLockedRef.current = false;
    speedGestureRef.current = true;
    const up = RATE_OPTIONS.filter((r) => r > rateRef.current);
    holdLevelsRef.current = up.length ? up : [rateRef.current];
    speedLevelRef.current = 0;
    const first = holdLevelsRef.current[0];
    setHoldRate(first); setSpeedHolding(true); setRateMenuOpen(false);
    if (videoRef.current) videoRef.current.playbackRate = first;
    if (speedTimerRef.current) clearInterval(speedTimerRef.current);
    speedTimerRef.current = setInterval(() => {
      speedLevelRef.current = Math.min(speedLevelRef.current + 1, holdLevelsRef.current.length - 1);
      const s = holdLevelsRef.current[speedLevelRef.current];
      setHoldRate(s);
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
    if (!speedTimerRef.current) return;
    if (e.clientY - speedStartYRef.current > SPEED_LOCK_PX) {
      // Lock = pick this speed: it becomes the menu's rate.
      clearInterval(speedTimerRef.current);
      speedTimerRef.current = null;
      speedLockedRef.current = true;
      setRateTo(holdLevelsRef.current[speedLevelRef.current]);
      setHoldRate(null); setSpeedHolding(false); setSpeedLocked(true);
    }
  }
  function handleContainerPointerUp() {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; return; }
    if (!speedTimerRef.current) return;
    clearInterval(speedTimerRef.current);
    speedTimerRef.current = null;
    setSpeedHolding(false); setHoldRate(null);
    if (videoRef.current) videoRef.current.playbackRate = rateRef.current;
  }
  function clearLockedSpeed() {
    speedLockedRef.current = false;
    setSpeedLocked(false);
    setRateTo(1);
  }

  // ── Speed menu ──────────────────────────────────────────────────────────────
  function chooseRate(r: number) {
    speedLockedRef.current = false;
    setSpeedLocked(false);
    setRateTo(r);
    setRateMenuOpen(false);
  }
  useEffect(() => {
    if (!rateMenuOpen && !keysOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rateMenuRef.current?.contains(e.target as Node)) setRateMenuOpen(false);
      if (!keysMenuRef.current?.contains(e.target as Node)) setKeysOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [rateMenuOpen, keysOpen]);

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

  const ctrlsShown = ctrlsVisible || !!pendingSpan || rateMenuOpen || keysOpen || barBusy;

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
            if (v) { v.defaultPlaybackRate = rateRef.current; v.playbackRate = rateRef.current; }
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

      {speedLocked && rate !== 1 && (
        <button type="button" className="mp-speed-badge" onClick={(e) => { e.stopPropagation(); clearLockedSpeed(); }}>
          {rate}× — tap to clear
        </button>
      )}

      {(rightHover || speedHolding) && !speedLocked && (
        <div className={`mp-speed-zone${speedHolding ? ' mp-speed-zone--holding' : ''}`} aria-hidden>
          {speedHolding ? (
            <>
              <span className="mp-speed-zone-rate">{holdRate ?? rate}×</span>
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

      {duration > 0 && (
        <div className={`mp-progress-line${ctrlsShown ? "" : " mp-progress-line--on"}`} aria-hidden><div style={{ width: `${(currentTime / duration) * 100}%` }} /></div>
      )}

      <div className={`mp-controls-bar${ctrlsShown ? ' mp-controls-bar--visible' : ''}`}>
        <ReviewBar
          duration={duration}
          currentTime={currentTime}
          buffered={buffered}
          playing={playing}
          markers={markers}
          selectedId={selectedId}
          onSelect={onSelect}
          pendingSpan={pendingSpan}
          onPendingSpanChange={onPendingSpanChange}
          onSpanMarked={onSpanMarked}
          onSeek={seekBar}
          onPause={() => videoRef.current?.pause()}
          onResume={() => { void videoRef.current?.play(); }}
          onBusyChange={setBarBusy}
          thumbnailUrl={thumbnailUrl}
          nearestThumbTime={(t) => nearestGridTime(t)}
        />

        <div className="mp-btn-row">
          <button type="button" className="mp-btn"
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
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
          <div className="mp-rate-wrap" ref={rateMenuRef}>
            <button type="button" className={`mp-btn mp-rate-btn${(holdRate ?? rate) !== 1 ? ' mp-rate-btn--on' : ''}`}
              onClick={(e) => { e.stopPropagation(); setKeysOpen(false); setRateMenuOpen((o) => !o); }}
              aria-label={`Playback speed ${holdRate ?? rate}×`} aria-haspopup="menu" aria-expanded={rateMenuOpen} title="Playback speed">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 14l4-4" /><path d="M3.34 19a10 10 0 1117.32 0" /></svg>
              {(holdRate ?? rate) !== 1 && <span className="mp-rate-label">{holdRate ?? rate}×</span>}
            </button>
            {rateMenuOpen && (
              <div className="mp-rate-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                {RATE_OPTIONS.map((r) => (
                  <button key={r} type="button" role="menuitemradio" aria-checked={rate === r}
                    className={`mp-rate-opt${rate === r ? ' mp-rate-opt--on' : ''}`} onClick={() => chooseRate(r)}>
                    {r}×
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mp-rate-wrap" ref={keysMenuRef}>
            <button type="button" className="mp-btn"
              onClick={(e) => { e.stopPropagation(); setRateMenuOpen(false); setKeysOpen((o) => !o); }}
              aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-expanded={keysOpen} title="Keyboard shortcuts">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
            </button>
            {keysOpen && (
              <div className="mp-keys-menu" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
                <dl>
                  {SHORTCUTS.map(([k, what]) => (
                    <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>
                  ))}
                </dl>
              </div>
            )}
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
