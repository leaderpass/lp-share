'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type HlsPlayer from 'hls.js';

/**
 * Attaches a Cloudflare Stream HLS manifest to a <video>. Ported from LPOS
 * hooks/useHlsPlayer.ts. hls.js is preferred wherever MSE exists (Chromium
 * reports native HLS but plays multi-rendition streams poorly and offers no
 * rendition control); native playback is the fallback (iOS Safari). hls.js is
 * lazy-loaded. Returns a quality toggle (Auto ⇄ full resolution).
 */

const HLS_RE = /\.m3u8(\?|#|$)/i;
// Optimistic cold-start bandwidth so playback opens at high quality instead of
// climbing from the lowest rendition; ABR still steps down if it can't keep up.
const START_BW_ESTIMATE = 5_000_000;
const CF_BANDWIDTH_HINT_MBPS = 5;

export type QualityMode = 'auto' | 'max';

export interface HlsController {
  hasLevels: boolean;
  mode: QualityMode;
  setMode: (m: QualityMode) => void;
}

/** Cloudflare honours ?clientBandwidthHint on the manifest (helps native Safari too). */
function withBandwidthHint(url: string): string {
  if (!HLS_RE.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}clientBandwidthHint=${CF_BANDWIDTH_HINT_MBPS}`;
}

export function useHlsPlayer(videoRef: RefObject<HTMLVideoElement | null>, src: string): HlsController {
  const [hasLevels, setHasLevels] = useState(false);
  const [mode, setModeState] = useState<QualityMode>('auto');
  const hlsRef = useRef<HlsPlayer | null>(null);
  const topLevelRef = useRef(-1);
  const modeRef = useRef<QualityMode>('auto');

  const setMode = useCallback((m: QualityMode) => {
    modeRef.current = m;
    setModeState(m);
    const inst = hlsRef.current;
    if (inst) inst.currentLevel = m === 'max' && topLevelRef.current >= 0 ? topLevelRef.current : -1;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setHasLevels(false);
    topLevelRef.current = -1;
    let destroyed = false;
    let hls: HlsPlayer | null = null;
    const url = withBandwidthHint(src);

    void (async () => {
      if (HLS_RE.test(url)) {
        const { default: Hls } = await import('hls.js');
        if (destroyed || !videoRef.current) return;
        if (Hls.isSupported()) {
          const inst = new Hls({ enableWorker: true, abrEwmaDefaultEstimate: START_BW_ESTIMATE });
          hlsRef.current = inst;
          inst.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            topLevelRef.current = data.levels.length - 1;
            setHasLevels(data.levels.length > 1);
            if (modeRef.current === 'max' && topLevelRef.current >= 0) inst.currentLevel = topLevelRef.current;
          });
          inst.loadSource(url);
          inst.attachMedia(videoRef.current);
          hls = inst;
          return;
        }
      }
      if (videoRef.current) videoRef.current.src = url;
    })();

    return () => {
      destroyed = true;
      if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
      hlsRef.current = null;
      const v = videoRef.current;
      if (v) { v.removeAttribute('src'); v.load(); }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return { hasLevels, mode, setMode };
}
