'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState, useRef, MouseEvent } from 'react';
import { useMediaInfo } from '@/app/hooks/useMediaInfo';
import Image from 'next/image';

type RepeatMode = 'none' | 'track' | 'list';

type MediaSnapshotDto = {
  props: {
    title: string;
    artist: string;
    album_title?: string | null;
    album_image?: string | null;
  };
  is_playing: boolean;
  position_ms?: number | null;
  duration_ms?: number | null;
  is_shuffle?: boolean | null;
  repeat_mode?: RepeatMode | null;
  source_app_id?: string | null;
};

async function sendControl(action: 'playPause' | 'next' | 'previous') {
  try {
    await invoke('control_media', { action });
    if (action === 'next' || action === 'previous') {
      // Ask backend for an immediate fresh snapshot
      await invoke('refresh_media_snapshot');
    }
  } catch (e) {
    console.error('control_media failed', e);
  }
}

async function sendPlaybackMode(mode: 'shuffle' | 'repeat', value: boolean) {
  try {
    if (mode === 'shuffle') {
      await invoke('set_shuffle', { active: value });
    } else if (mode === 'repeat') {
      await invoke('set_repeat', { mode: value ? 'track' : 'none' });
    }
  } catch (e) {
    console.error('sendPlaybackMode failed', e);
  }
}

async function sendSeek(positionMs: number) {
  try {
    await invoke('seek_to', { positionMs });
  } catch (e) {
    console.error('seek_to failed', e);
  }
}

export default function OverlayPage() {
  const media = useMediaInfo(); // existing gsmtc-based metadata (title/artist/album_image)
  useEffect(() => {
    console.log('OverlayPage mounted');
  }, []);
  const [snapshot, setSnapshot] = useState<MediaSnapshotDto | null>(null);
  const [playElapsedMs, setPlayElapsedMs] = useState(0);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<MediaSnapshotDto>('media_snapshot', (event) => {
      setSnapshot(event.payload);
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    // If not playing or no valid duration, stop and reset.
    if (!snapshot?.is_playing || !snapshot?.duration_ms || snapshot.duration_ms <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlayElapsedMs(0);
      return;
    }

    let frameId: number;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = now - last;
      last = now;

      setPlayElapsedMs((prev) => {
        const next = prev + dt;
        return Math.min(next, snapshot.duration_ms!);
      });

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    // Cleanup: cancel loop and reset elapsed when playback state/duration change
    return () => {
      cancelAnimationFrame(frameId);
      setPlayElapsedMs(0);
    };
  }, [snapshot?.is_playing, snapshot?.duration_ms]);


  const hasSnapshotTitle = !!snapshot?.props?.title;
  const hasMediaTitle = !!media?.title;
  const hasAnyMedia = hasSnapshotTitle || hasMediaTitle;

  const sourceAppId = snapshot?.source_app_id ?? null;

  // Track last seen sourceAppId and log only when it changes
  const lastSourceAppIdRef = useRef<string | null>(null);

  useEffect(() => {
    const current = snapshot?.source_app_id ?? null;
    if (lastSourceAppIdRef.current !== current) {
      // Only log when the source app id actually changes
      console.log('source_app_id changed:', current);
      lastSourceAppIdRef.current = current;
    }
  }, [snapshot?.source_app_id]);

  const effectiveTitle = snapshot?.props?.title || media?.title;
  const effectiveArtist = snapshot?.props?.artist || media?.artist;
  const effectiveAlbumTitle = snapshot?.props?.album_title ?? media?.album_title ?? null;

  // Title scrolling: measure overflow and animate when needed
  const titleContainerRef = useRef<HTMLDivElement | null>(null);
  const titleInnerRef = useRef<HTMLSpanElement | null>(null);
  const [titleScroll, setTitleScroll] = useState<{ should: boolean; duration: number; delay: number; fadeKeyframes?: string }>({ should: false, duration: 0, delay: 0 });

  // Animation control refs
  const animationStartTimerRef = useRef<number | null>(null);
  const animationPauseTimerRef = useRef<number | null>(null);
  const animationListenerRef = useRef<((e: AnimationEvent) => void) | null>(null);

  useEffect(() => {
    const container = titleContainerRef.current;
    const inner = titleInnerRef.current;
    if (!container || !inner) return;

    const measureTextWidth = (txt: string, comp: CSSStyleDeclaration) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        const fontSize = comp.fontSize || '16px';
        const fontWeight = comp.fontWeight || '400';
        const fontFamily = comp.fontFamily || 'sans-serif';
        const fontStyle = comp.fontStyle || 'normal';
        ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
        return ctx.measureText(txt).width;
      } catch {
        return 0;
      }
    };

    const check = () => {
      window.requestAnimationFrame(() => {
        const innerScrollWidth = inner.scrollWidth;
        const innerOffsetWidth = inner.offsetWidth;
        const containerWidth = container.clientWidth;
        const text = inner.textContent?.trim() ?? '';
        const computed = window.getComputedStyle(inner);

        const measuredInnerWidth = innerScrollWidth || measureTextWidth(text, computed) || innerOffsetWidth || 0;

        let should = measuredInnerWidth > containerWidth;
        let usedContainerWidth = containerWidth;

        if (!should) {
          let p: HTMLElement | null = inner.parentElement as HTMLElement | null;
          while (p && p !== document.body) {
            if (p.clientWidth && p.clientWidth < measuredInnerWidth) {
              should = true;
              usedContainerWidth = p.clientWidth;
              break;
            }
            p = p.parentElement as HTMLElement | null;
          }
        }



        if (should) {
          const distance = measuredInnerWidth + usedContainerWidth; // px to travel
          const speed = 60; // px per second (slower)
          const travelSeconds = distance / speed;
          const initialDelay = 2; // seconds before first scroll
          const pauseBetween = 1.5; // seconds to pause after one full scroll

          
          // Create dynamic keyframes for opacity fade-out with the animation duration
          const fadeOutDuration = 2; // seconds for fade-out
          const fadeOutStartPercent = ((travelSeconds - fadeOutDuration) / travelSeconds) * 100;
          
          const keyframesId = `marquee-fade-${Math.random().toString(36).substr(2, 9)}`;
          const keyframesCSS = `@keyframes ${keyframesId} { 0% { opacity: 1; } ${fadeOutStartPercent.toFixed(2)}% { opacity: 1; } 100% { opacity: 0; } }`;

          
          // Inject the dynamic keyframes
          const w = globalThis as { marqueeStyleSheet?: HTMLStyleElement };
          if (!w.marqueeStyleSheet) {
            const sheet = document.createElement('style');
            document.head.appendChild(sheet);
            w.marqueeStyleSheet = sheet;
          }
          w.marqueeStyleSheet.textContent += keyframesCSS;
          

          setTitleScroll({ should: true, duration: travelSeconds, delay: initialDelay, fadeKeyframes: keyframesId });
          try {
            (inner as HTMLElement).dataset.marqueePause = String(pauseBetween);
            (inner as HTMLElement).dataset.fadeKeyframes = keyframesId;
          } catch {
            // ignore
          }
        } else {
          setTitleScroll({ should: false, duration: 0, delay: 0 });
        }
      });
    };

    check();
    const ro = new ResizeObserver(check);
    ro.observe(container);
    ro.observe(inner);
    window.addEventListener('resize', check);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [effectiveTitle]);

  // Control the animation lifecycle: JS toggles the `.marquee-anim` class so we can pause and reset between runs.
  useEffect(() => {
    const inner = titleInnerRef.current;
    if (!inner) return;

    const clearTimers = () => {
      if (animationStartTimerRef.current) {
        window.clearTimeout(animationStartTimerRef.current);
        animationStartTimerRef.current = null;
      }
      if (animationPauseTimerRef.current) {
        window.clearTimeout(animationPauseTimerRef.current);
        animationPauseTimerRef.current = null;
      }
    };

    const pauseBetween = parseFloat((inner as HTMLElement).dataset.marqueePause || '1.25');

    const onEnd = () => {
      // One run finished. Stop animation and pause before restarting.
      inner.style.removeProperty('animation');
      inner.style.removeProperty('transform');
      clearTimers();

      const pauseMs = Math.round(pauseBetween * 1000);

      // schedule restart at end of pause
      animationStartTimerRef.current = window.setTimeout(() => {
        // Reapply the animation
        const fadeKeyframes = (inner as HTMLElement).dataset.fadeKeyframes;
        if (fadeKeyframes) {
          const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
          inner.style.animation = animationValue;
          inner.style.animationIterationCount = '1';
          // force reflow to restart animation
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          inner.offsetWidth;
        }
      }, pauseMs);
    };

    animationListenerRef.current = onEnd;
    inner.addEventListener('animationend', onEnd as EventListener);

    // Setup or teardown based on `titleScroll.should`
    clearTimers();
    inner.style.removeProperty('animation');
    inner.style.removeProperty('transform');
    inner.style.removeProperty('--marquee-travel');

    if (titleScroll.should) {
      inner.style.setProperty('--marquee-travel', `${titleScroll.duration}s`);
      // Apply both position and opacity animations after the initial delay
      const delayMs = Math.round(titleScroll.delay * 1000);
      animationStartTimerRef.current = window.setTimeout(() => {
        // Get fadeKeyframes from the state passed in the effect
        const fadeKeyframes = titleScroll.fadeKeyframes;
        if (fadeKeyframes) {
          // Apply the animation directly via inline style
          const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
          inner.style.animation = animationValue;
          inner.style.animationIterationCount = '1';
        }
        // force reflow to ensure animation starts
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        inner.offsetWidth;
      }, delayMs);
    }

    return () => {
      clearTimers();
      inner.removeEventListener('animationend', onEnd as EventListener);
      inner.style.removeProperty('--marquee-travel');
      inner.style.removeProperty('transform');
      inner.style.removeProperty('animation');
      inner.style.removeProperty('animation-iteration-count');
    };
  }, [titleScroll.should, titleScroll.duration, titleScroll.delay, titleScroll.fadeKeyframes, effectiveTitle]);

  const snapshotImage = snapshot?.props?.album_image
    ? `data:image/png;base64,${snapshot.props.album_image}`
    : null;

  const mediaImage = media?.album_image
    ? `data:image/png;base64,${media.album_image}`
    : null;

  const imageSrc = snapshotImage || mediaImage;

  const durationMs = snapshot?.duration_ms ?? null;
  const basePositionMs = snapshot?.position_ms ?? null;

  const isPlaying = snapshot?.is_playing ?? false;
  const isShuffle = snapshot?.is_shuffle ?? false;
  const repeatMode: RepeatMode | null = snapshot?.repeat_mode ?? null;
  const isRepeat = repeatMode === 'track' || repeatMode === 'list';

  let effectivePositionMs = basePositionMs;

  if (
    isPlaying &&
    durationMs &&
    durationMs > 0 &&
    basePositionMs != null
  ) {
    const advanced = basePositionMs + playElapsedMs;
    effectivePositionMs = Math.min(durationMs, advanced);
  }

  const hasTimeline = durationMs && durationMs > 0;

  const progress =
    hasTimeline && effectivePositionMs != null
      ? Math.min(1, Math.max(0, effectivePositionMs / durationMs))
      : 0;

  const handleProgressClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!hasTimeline || !durationMs) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, x / rect.width));
    const targetMs = Math.round(durationMs * fraction);
    sendSeek(targetMs);
  };

  return (
    <div
      className="w-screen h-screen flex items-center flex-start gap-1 flex-row px-2 py-1.5"
      style={{ background: 'rgba(0,0,0,0.75)', WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
    >
      {hasAnyMedia ? (
        <>
          <div
            className="flex flex-col items-center justify-center p-1 min-w-25 min-h-25"
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
          >
            {imageSrc && (
              <Image
                src={imageSrc}
                alt={effectiveAlbumTitle || 'No Album Art'}
                className="w-24 h-24 rounded-md object-cover"
                draggable={false}
                onDragStart={(e) => {
                  if (pinned) e.preventDefault();
                }}
                style={{ 
                  WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                  userSelect: 'none',
                } as never}
                width={128}
                height={128}
              />
            )}
          </div>
          <div
            className="flex flex-col content-center justify-center w-70"
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
          >
            <div
              className="flex items-center gap-0.5 flex-col w-full"
              style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
            >
              <div
                ref={titleContainerRef}
                className="text-lg font-semibold text-white w-full marquee-container"
                style={{ 
                  WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                  userSelect: 'none',
                } as never}
              >
                <span
                  ref={titleInnerRef}
                  className={'marquee-inner' + (titleScroll.should ? ' marquee' : '')}
                >
                  {effectiveTitle}
                </span>
              </div>
              <div
                className="text-sm text-white/80 w-full"
                style={{ 
                  WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                  userSelect: 'none',
                } as never}
              >
                {effectiveArtist}
              </div>
              {media?.album_title && (
                <div
                  className="text-xs text-white/60 w-full"
                  style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
                >
                  {effectiveAlbumTitle}
                </div>
              )}
            </div>

            {/* Timeline */}
            {hasTimeline && (
              <div
                className="mt-2 w-full h-1.5 bg-white/15 rounded-full cursor-pointer"
                style={{ 
                  WebkitAppRegion: 'no-drag',
                  userSelect: 'none',
                } as never}
                onClick={handleProgressClick}
              >
                <div
                  className="h-full bg-white rounded-full"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}

            <div
              className="flex items-center gap-3 mt-3 justify-center"
              style={{ 
                WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                userSelect: 'none',
              } as never}
            >
              {sourceAppId == 'com.squirrel.TIDAL.TIDAL' || sourceAppId == 'Chrome' ? null :
                <button
                  className={
                    'px-2 py-1 rounded-full text-xs ' +
                    (isRepeat
                      ? 'bg-white text-black font-semibold'
                      : 'bg-white/10 hover:bg-white/20 text-white')
                  }
                  onClick={() => sendPlaybackMode('repeat', !isRepeat)}
                  id="repeat-button"
                  style={{ WebkitAppRegion: 'no-drag' } as never}
                >
                  🔁
                </button>
              }
              <button
                className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
                id="back-button"
                onClick={() => sendControl('previous')}
                style={{ WebkitAppRegion: 'no-drag' } as never}
              >
                I◀◀
              </button>
              <button
                className="px-3 py-1 rounded-full bg-white hover:bg-white/80 text-xs text-black font-semibold"
                id="play-pause-button"
                onClick={() => sendControl('playPause')}
                style={{ WebkitAppRegion: 'no-drag' } as never}
              >
                {isPlaying ? ' ⏸ ' : ' ▶ '}
              </button>
              <button
                className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
                id="next-button"
                onClick={() => sendControl('next')}
                style={{ WebkitAppRegion: 'no-drag' } as never}
              >
                ▶▶I
              </button>
              {sourceAppId == 'com.squirrel.TIDAL.TIDAL' || sourceAppId == 'Chrome' ? null :
                <button
                  className={
                    'px-2 py-1 rounded-full text-xs ' +
                    (isShuffle
                      ? 'bg-white text-black font-semibold'
                      : 'bg-white/10 hover:bg-white/20 text-white')
                  }
                  onClick={() => sendPlaybackMode('shuffle', !isShuffle)}
                  id="shuffle-button"
                  style={{ WebkitAppRegion: 'no-drag' } as never}
                >
                  🔀
                </button>
              }              
            </div>
            <div className="fixed bottom-3.5 right-2">
              <button
                className={
                  'px-2 py-1 rounded-full text-xs ' +
                  (pinned
                    ? 'bg-white hover:bg-white/80 text-black'
                    : 'bg-white/10 hover:bg-white/20 text-white')
                }
                onClick={() => setPinned((v) => !v)}
                style={{ WebkitAppRegion: 'no-drag' } as never}
              >
                {pinned ? '📍' : '📌'}
              </button>
            </div>
          </div>
        </>
      ) : (
        // Placeholder when no media
        <div
          className="flex flex-col items-center justify-center w-full py-4"
          style={{ WebkitAppRegion: 'drag' } as never}
        >
          <div className="text-sm text-white/60">
            🔇 No media is currently playing 🔇
          </div>
          <div className="text-xs text-white/40 mt-1">
            🎵 Start playback in your favorite player to see controls here 🎶
          </div>
        </div>
      )}
    </div>

  );
}
