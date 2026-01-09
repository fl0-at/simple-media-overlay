'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect, useState, useRef, MouseEvent, useMemo } from 'react';
import { useMediaInfo } from '@/app/hooks/useMediaInfo';
import { AlbumArt } from './AlbumArt';
import { MediaInfo } from './MediaInfo';
import { MediaTimeline } from './MediaTimeline';
import { MediaControls } from './MediaControls';
import { WindowControls } from '../WindowControls';
import UpdateNotification from './UpdateNotification';
import { StyledImage } from '../StyledImage';
import { getPlayerInfo } from './appInfo';
import { ListMusic, Loader2 } from 'lucide-react';

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

async function sendControl(action: 'playPause' | 'next' | 'previous', setDirection?: (dir: 'next' | 'previous' | null) => void, setFading?: (fading: boolean) => void) {
  try {
    // Set direction before control action
    if ((action === 'next' || action === 'previous') && setDirection) {
      setDirection(action);
      // Trigger immediate fade-out for visual feedback
      if (setFading) {
        setFading(true);
        // Auto-clear fading after 1500ms in case track doesn't actually change
        // (e.g., "previous" just restarts current track)
        setTimeout(() => {
          setFading(false);
        }, 1500);
      }
    }

    await invoke('control_media', { action });
    if (action === 'next' || action === 'previous') {
      // Immediate refresh
      await invoke('refresh_media_snapshot');
      // Additional delayed refresh to catch slow metadata updates from some apps (e.g., TIDAL)
      setTimeout(() => {
        invoke('refresh_media_snapshot').catch(() => { });
      }, 300);
      setTimeout(() => {
        invoke('refresh_media_snapshot').catch(() => { });
      }, 600);
    }
  } catch (e) {
    console.error('control_media failed', e);
  }
}

async function sendPlaybackMode(mode: 'shuffle' | 'repeat', value: boolean | RepeatMode) {
  try {
    if (mode === 'shuffle') {
      await invoke('set_shuffle', { active: value as boolean });
    } else if (mode === 'repeat') {
      await invoke('set_repeat', { mode: value as RepeatMode });
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
  const media = useMediaInfo();

  const [snapshot, setSnapshot] = useState<MediaSnapshotDto | null>(null);
  const currentSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const pendingSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const [playElapsedMs, setPlayElapsedMs] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [lyricsOverlayOpen, setLyricsOverlayOpen] = useState(false);
  const [lyricsAvailable, setLyricsAvailable] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);

  // Track change animation state
  const [trackChangeDirection, setTrackChangeDirection] = useState<'next' | 'previous' | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [animationKey, setAnimationKey] = useState(0);
  const previousTitleRef = useRef<string | undefined>(undefined);

  // App switch animation state
  const [appSwitchDirection, setAppSwitchDirection] = useState<'up' | 'down' | null>(null);
  const [appSwitchAnimating, setAppSwitchAnimating] = useState(false);

  const lastSourceAppIdRef = useRef<string | null>(null);
  const [frozenSnapshot, setFrozenSnapshot] = useState<MediaSnapshotDto | null>(null);
  const previousSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const [appSwitchTrigger, setAppSwitchTrigger] = useState(0);

  // Play/pause impact animation
  const [playPauseImpact, setPlayPauseImpact] = useState(false);
  const previousPlayStateRef = useRef<boolean | undefined>(undefined);

  // Pin button ripple
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);
  // Lyrics toggle button ripple
  const [lyricsRipples, setLyricsRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);

  // Disable context menu when pinned (allow native Windows menu when unpinned)
  useEffect(() => {
    const handleContextMenu = (e: Event) => {
      if (pinned) {
        e.preventDefault();
        return false;
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [pinned]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let lyricsCloseUnlisten: (() => void) | undefined;

    // Listen for lyrics window close
    listen('lyrics-window-closed', () => {
      setLyricsOverlayOpen(false);
    }).then((u) => {
      lyricsCloseUnlisten = u;
    });

    // Fetch initial snapshot on mount/refresh
    invoke('refresh_media_snapshot').catch((e) =>
      console.error('refresh_media_snapshot failed on mount', e)
    );

    listen<MediaSnapshotDto>('media_snapshot', (event) => {
      const newSourceAppId = event.payload.source_app_id ?? null;
      const currentSourceAppId = currentSnapshotRef.current?.source_app_id ?? null;

      // Check if this is an app switch
      if (currentSourceAppId !== null && newSourceAppId !== currentSourceAppId) {

        // Store both old and new snapshots
        previousSnapshotRef.current = currentSnapshotRef.current;
        pendingSnapshotRef.current = event.payload;

        // DON'T update currentSnapshotRef yet - we need it to stay as the old snapshot
        // for the freeze to work correctly. It will be updated in the effect.

        // Trigger the app switch effect
        setAppSwitchTrigger(prev => prev + 1);
      } else {
        // Normal update - no app switch
        previousSnapshotRef.current = currentSnapshotRef.current;
        currentSnapshotRef.current = event.payload;
        setSnapshot(event.payload);

        // Emit event for lyrics window
        emit('media-updated', {
          title: event.payload.props.title,
          artist: event.payload.props.artist,
          albumTitle: event.payload.props.album_title,
          durationMs: event.payload.duration_ms,
          positionMs: event.payload.position_ms,
        });

        // If this is the first snapshot and position seems incorrect (null or 0) while playing,
        // request a refresh after a short delay to get accurate position
        if (!currentSnapshotRef.current &&
          event.payload.is_playing &&
          event.payload.duration_ms &&
          event.payload.duration_ms > 0 &&
          (!event.payload.position_ms || event.payload.position_ms === 0)) {
          setTimeout(() => {
            invoke('refresh_media_snapshot').catch(() => { });
          }, 200);
        }
      }
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      if (unlisten) unlisten();
      if (lyricsCloseUnlisten) lyricsCloseUnlisten();
    };
  }, []);

  useEffect(() => {
    if (!snapshot?.is_playing || !snapshot?.duration_ms || snapshot.duration_ms <= 0) {
      return;
    }

    // Reset elapsed time whenever this effect runs (on position/playing state change)
    // This ensures we always start fresh from the latest snapshot position
    if (!isAnimating) {
      setPlayElapsedMs(0);
    }

    let frameId: number;
    let last = performance.now();
    const durationMs = snapshot.duration_ms;
    const positionMs = snapshot.position_ms ?? 0;
    let lastEmitTime = 0;

    const tick = (now: number) => {
      const deltaMs = now - last;
      last = now;

      setPlayElapsedMs((prev) => {
        const next = prev + deltaMs;
        const maxElapsed = durationMs - positionMs;
        const newPosition = Math.min(next, maxElapsed);

        // Emit position update to lyrics window every 100ms
        if (now - lastEmitTime >= 100) {
          emit('playback-position', { positionMs: positionMs + newPosition });
          lastEmitTime = now;
        }

        return newPosition;
      });

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [snapshot?.is_playing, snapshot?.duration_ms, snapshot?.position_ms, isAnimating]);

  const hasSnapshotTitle = !!snapshot?.props?.title;
  const hasMediaTitle = !!media?.title;
  const hasActiveMedia = hasSnapshotTitle || hasMediaTitle;

  const sourceAppId = snapshot?.source_app_id ?? null;

  useEffect(() => {
    const current = snapshot?.source_app_id ?? null;
    if (lastSourceAppIdRef.current !== current && lastSourceAppIdRef.current !== null) {
      // App switched - force a refresh to get updated snapshot from new app
      invoke('refresh_media_snapshot').catch((e) =>
        console.error('refresh_media_snapshot failed on app switch', e)
      );
      lastSourceAppIdRef.current = current;
    } else if (lastSourceAppIdRef.current === null) {
      // First initialization
      lastSourceAppIdRef.current = current;
    }
  }, [snapshot?.source_app_id]);

  const effectiveTitle = useMemo(
    () => (frozenSnapshot || snapshot)?.props?.title || media?.title,
    [frozenSnapshot, snapshot, media?.title]
  );

  // Track last title to clear stale artist/album when switching songs
  const [lastTitle, setLastTitle] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLastTitle(effectiveTitle);
  }, [effectiveTitle]);

  // Detect track changes and trigger animation
  useEffect(() => {
    const currentTitle = effectiveTitle;

    // Skip if we have a pending snapshot (app switch in progress) OR app switch animation is active
    if (pendingSnapshotRef.current || appSwitchDirection) {
      // Update ref but don't trigger animation - app switch will handle it
      previousTitleRef.current = currentTitle;
      return;
    }

    // Only animate if we have a previous title and it's different
    // AND we're not currently doing an app switch animation
    if (previousTitleRef.current && currentTitle && previousTitleRef.current !== currentTitle && !appSwitchDirection) {
      // If no direction was set (external control), default to 'next'
      if (!trackChangeDirection) {
        setTrackChangeDirection('next');
      }

      // Clear fading and start slide animation
      setIsFading(false);

      // Increment key to force animation retrigger
      setAnimationKey(prev => prev + 1);
      setIsAnimating(true);

      // Clear animation state after it completes
      const timer = setTimeout(() => {
        setIsAnimating(false);
        setTrackChangeDirection(null); // Clear direction after animation
        // Reset playElapsedMs after animation to sync with new track
        setPlayElapsedMs(0);
      }, 350); // Slightly longer than animation duration to ensure completion

      previousTitleRef.current = currentTitle;
      return () => clearTimeout(timer);
    } else if (currentTitle) {
      previousTitleRef.current = currentTitle;
    }
  }, [effectiveTitle, trackChangeDirection, appSwitchDirection]);

  // Detect app switches (sourceAppId changes)
  useEffect(() => {
    // Check if we have a pending snapshot (app switch happened in listener)
    if (pendingSnapshotRef.current) {
      const newSourceAppId = pendingSnapshotRef.current.source_app_id ?? null;
      const currentSourceAppId = currentSnapshotRef.current?.source_app_id ?? null;

      // Determine direction based on alphabetical order of app IDs
      const previous = currentSourceAppId || '';
      const current = newSourceAppId || '';
      const direction = current.localeCompare(previous) > 0 ? 'down' : 'up';

      // Freeze the current (old) snapshot
      setFrozenSnapshot(currentSnapshotRef.current);
      setAppSwitchDirection(direction);
      setIsFading(true);
      setIsAnimating(true);
      setAppSwitchAnimating(false);

      // After grey-out, update to new snapshot but keep it frozen
      const slideOutTimer = setTimeout(() => {
        const pending = pendingSnapshotRef.current;
        if (pending) {
          currentSnapshotRef.current = pending; // Now update to new snapshot
          setSnapshot(pending);
          // DON'T clear pendingSnapshotRef yet - keep it to block track change animation
        }
        setIsFading(false);
        // First, apply the animation class so new content will be positioned off-screen
        requestAnimationFrame(() => {
          setAppSwitchAnimating(true);
          // Then clear frozen snapshot so new content becomes visible (already off-screen)
          requestAnimationFrame(() => {
            setFrozenSnapshot(null);
          });
        });
      }, 175);

      // Clean up animation states
      const cleanupTimer = setTimeout(() => {
        setIsAnimating(false);
        setAppSwitchAnimating(false);
        setAppSwitchDirection(null);
        setPlayElapsedMs(0);
        pendingSnapshotRef.current = null; // Clear it here after full animation
      }, 475);

      return () => {
        clearTimeout(slideOutTimer);
        clearTimeout(cleanupTimer);
      };
    }
  }, [appSwitchTrigger]);

  // Detect play/pause state changes (including external controls)
  useEffect(() => {
    const currentPlayState = snapshot?.is_playing;

    // Only trigger animation if state actually changed
    if (previousPlayStateRef.current !== undefined && currentPlayState !== previousPlayStateRef.current) {
      setPlayPauseImpact(true);
      setTimeout(() => setPlayPauseImpact(false), 300);
    }

    previousPlayStateRef.current = currentPlayState;
  }, [snapshot?.is_playing]);

  // Only use media fallback if title hasn't changed (same song); otherwise use snapshot values only
  const shouldUseFallback = effectiveTitle === lastTitle;
  const effectiveSnapshot = frozenSnapshot || snapshot;
  const effectiveArtist = useMemo(
    () => effectiveSnapshot?.props?.artist || (shouldUseFallback ? media?.artist : ''),
    [effectiveSnapshot?.props?.artist, shouldUseFallback, media?.artist]
  );
  const effectiveAlbumTitle = useMemo(
    () => effectiveSnapshot?.props?.album_title ?? (shouldUseFallback ? media?.album_title : null) ?? null,
    [effectiveSnapshot?.props?.album_title, shouldUseFallback, media?.album_title]
  );

  // Title scrolling
  const titleContainerRef = useRef<HTMLDivElement | null>(null);
  const titleInnerRef = useRef<HTMLSpanElement | null>(null);
  const [titleMarqueeConfig, setTitleMarqueeConfig] = useState<{ isActive: boolean; duration: number; delay: number; fadeKeyframes?: string }>({ isActive: false, duration: 0, delay: 0 });

  const animationStartTimerRef = useRef<number | null>(null);
  const animationPauseTimerRef = useRef<number | null>(null);
  const animationListenerRef = useRef<((e: AnimationEvent) => void) | null>(null);
  const titleHasPlayedRef = useRef<boolean>(false);

  // Artist scrolling
  const artistContainerRef = useRef<HTMLDivElement | null>(null);
  const artistInnerRef = useRef<HTMLSpanElement | null>(null);
  const [artistMarqueeConfig, setArtistMarqueeConfig] = useState<{ isActive: boolean; duration: number; delay: number; fadeKeyframes?: string }>({ isActive: false, duration: 0, delay: 0 });

  const artistAnimationStartTimerRef = useRef<number | null>(null);
  const artistAnimationPauseTimerRef = useRef<number | null>(null);
  const artistAnimationListenerRef = useRef<((e: AnimationEvent) => void) | null>(null);
  const artistHasPlayedRef = useRef<boolean>(false);

  // Sync state for coordinating title and artist scrolling
  const [syncedDuration, setSyncedDuration] = useState(0);
  const [marqueeSync, setMarqueeSync] = useState(0); // timestamp to trigger synchronized starts

  useEffect(() => {
    const container = titleContainerRef.current;
    const inner = titleInnerRef.current;
    if (!container || !inner) return;

    const measureTextWidth = (text: string, computedStyle: CSSStyleDeclaration) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        const fontSize = computedStyle.fontSize || '16px';
        const fontWeight = computedStyle.fontWeight || '400';
        const fontFamily = computedStyle.fontFamily || 'sans-serif';
        const fontStyle = computedStyle.fontStyle || 'normal';
        ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
        return ctx.measureText(text).width;
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
          let parentElement: HTMLElement | null = inner.parentElement as HTMLElement | null;
          while (parentElement && parentElement !== document.body) {
            if (parentElement.clientWidth && parentElement.clientWidth < measuredInnerWidth) {
              should = true;
              usedContainerWidth = parentElement.clientWidth;
              break;
            }
            parentElement = parentElement.parentElement as HTMLElement | null;
          }
        }

        if (should) {
          const distance = measuredInnerWidth + usedContainerWidth;
          const speed = 60;
          const travelSeconds = distance / speed;
          const initialDelay = 0;  // 2
          const pauseBetween = 0; // 1.5

          const fadeOutDuration = 2;
          const fadeOutStartPercent = ((travelSeconds - fadeOutDuration) / travelSeconds) * 100;

          const keyframesId = `marquee-fade-${Math.random().toString(36).substr(2, 9)}`;
          const keyframesCSS = `@keyframes ${keyframesId} { 0% { opacity: 0; } 5% { opacity: 1; } ${fadeOutStartPercent.toFixed(2)}% { opacity: 1; } 100% { opacity: 0; } }`;

          // First-run keyframes: start at full opacity, only fade-out at end
          const firstRunKeyframesId = `marquee-fade-first-${Math.random().toString(36).substr(2, 9)}`;
          const firstRunKeyframesCSS = `@keyframes ${firstRunKeyframesId} { 0% { opacity: 1; } ${fadeOutStartPercent.toFixed(2)}% { opacity: 1; } 100% { opacity: 0; } }`;

          const globalState = globalThis as { marqueeStyleSheet?: HTMLStyleElement };
          if (!globalState.marqueeStyleSheet) {
            const sheet = document.createElement('style');
            document.head.appendChild(sheet);
            globalState.marqueeStyleSheet = sheet;
          }
          globalState.marqueeStyleSheet.textContent += keyframesCSS + firstRunKeyframesCSS;

          setTitleMarqueeConfig({ isActive: true, duration: travelSeconds, delay: initialDelay, fadeKeyframes: keyframesId });
          try {
            (inner as HTMLElement).dataset.marqueePause = String(pauseBetween);
            (inner as HTMLElement).dataset.fadeKeyframes = keyframesId;
            (inner as HTMLElement).dataset.fadeKeyframesFirst = firstRunKeyframesId;
            (inner as HTMLElement).dataset.travelDuration = String(travelSeconds);
          } catch {
            // ignore
          }
        } else {
          setTitleMarqueeConfig({ isActive: false, duration: 0, delay: 0 });
          try {
            (inner as HTMLElement).dataset.travelDuration = '0';
          } catch {
            // ignore
          }
        }
      });
    };

    check();
    const resizeObserver = new ResizeObserver(check);
    resizeObserver.observe(container);
    window.addEventListener('resize', check);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [effectiveTitle]);

  // Title scrolling animation
  useEffect(() => {
    const inner = titleInnerRef.current;
    if (!inner) return;

    titleHasPlayedRef.current = false;

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

    const pauseBetween = parseFloat((inner as HTMLElement).dataset.marqueePause || '1.5');

    const onEnd = () => {
      inner.style.removeProperty('animation');
      inner.style.removeProperty('transform');
      // Keep opacity at 0 to prevent flash before next animation
      inner.style.opacity = '0';
      clearTimers();

      titleHasPlayedRef.current = true;

      const pauseMs = Math.round(pauseBetween * 1000);

      animationStartTimerRef.current = window.setTimeout(() => {
        const fadeKeyframes = (inner as HTMLElement).dataset.fadeKeyframes;
        const fadeKeyframesFirst = (inner as HTMLElement).dataset.fadeKeyframesFirst;
        const shouldFade = fadeKeyframes && titleHasPlayedRef.current;

        if (fadeKeyframes) {
          if (shouldFade) {
            inner.style.opacity = '0';
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
            });
          } else if (fadeKeyframesFirst) {
            // First run: use first-run keyframes (no fade-in, only fade-out)
            inner.style.removeProperty('opacity');
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframesFirst} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
            });
          }
        }
      }, pauseMs);
    };

    animationListenerRef.current = onEnd;
    inner.addEventListener('animationend', onEnd as EventListener);

    clearTimers();
    inner.style.removeProperty('animation');
    inner.style.removeProperty('animation-fill-mode');
    inner.style.removeProperty('animation-iteration-count');
    inner.style.removeProperty('transform');
    inner.style.removeProperty('--marquee-travel');
    inner.style.removeProperty('opacity');

    if (titleMarqueeConfig.isActive && syncedDuration > 0) {
      inner.style.setProperty('--marquee-travel', `${syncedDuration}s`);
      const delayMs = Math.round(titleMarqueeConfig.delay * 1000);
      animationStartTimerRef.current = window.setTimeout(() => {
        const fadeKeyframes = titleMarqueeConfig.fadeKeyframes;
        const fadeKeyframesFirst = (inner as HTMLElement).dataset.fadeKeyframesFirst;
        const shouldFade = fadeKeyframes && titleHasPlayedRef.current;

        if (fadeKeyframes) {
          if (shouldFade) {
            inner.style.opacity = '0';
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
              const _forceReflow = inner.offsetWidth;
            });
          } else if (fadeKeyframesFirst) {
            // First run: use first-run keyframes (no fade-in, only fade-out)
            inner.style.removeProperty('opacity');
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframesFirst} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
              const _forceReflow = inner.offsetWidth;
            });
          }
        }
      }, delayMs);
    }

    return () => {
      clearTimers();
      inner.removeEventListener('animationend', onEnd as EventListener);
      inner.style.removeProperty('--marquee-travel');
      inner.style.removeProperty('transform');
      inner.style.removeProperty('animation');
      inner.style.removeProperty('animation-iteration-count');
      inner.style.removeProperty('animation-fill-mode');
      inner.style.removeProperty('opacity');
      titleHasPlayedRef.current = false;
    };
  }, [titleMarqueeConfig.isActive, titleMarqueeConfig.delay, titleMarqueeConfig.fadeKeyframes, syncedDuration, marqueeSync, effectiveTitle]);

  // Artist scrolling measurement
  useEffect(() => {
    const container = artistContainerRef.current;
    const inner = artistInnerRef.current;
    if (!container || !inner) return;

    const measureTextWidth = (text: string, computedStyle: CSSStyleDeclaration) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        const fontSize = computedStyle.fontSize || '16px';
        const fontWeight = computedStyle.fontWeight || '400';
        const fontFamily = computedStyle.fontFamily || 'sans-serif';
        const fontStyle = computedStyle.fontStyle || 'normal';
        ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
        return ctx.measureText(text).width;
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
          let parentElement: HTMLElement | null = inner.parentElement as HTMLElement | null;
          while (parentElement && parentElement !== document.body) {
            if (parentElement.clientWidth && parentElement.clientWidth < measuredInnerWidth) {
              should = true;
              usedContainerWidth = parentElement.clientWidth;
              break;
            }
            parentElement = parentElement.parentElement as HTMLElement | null;
          }
        }

        if (should) {
          const distance = measuredInnerWidth + usedContainerWidth;
          const speed = 60;
          const travelSeconds = distance / speed;
          const initialDelay = 0;
          const pauseBetween = 0;

          const fadeOutDuration = 2;
          const fadeOutStartPercent = ((travelSeconds - fadeOutDuration) / travelSeconds) * 100;

          const keyframesId = `marquee-fade-${Math.random().toString(36).substr(2, 9)}`;
          const keyframesCSS = `@keyframes ${keyframesId} { 0% { opacity: 0; } 5% { opacity: 1; } ${fadeOutStartPercent.toFixed(2)}% { opacity: 1; } 100% { opacity: 0; } }`;

          const firstRunKeyframesId = `marquee-fade-first-${Math.random().toString(36).substr(2, 9)}`;
          const firstRunKeyframesCSS = `@keyframes ${firstRunKeyframesId} { 0% { opacity: 1; } ${fadeOutStartPercent.toFixed(2)}% { opacity: 1; } 100% { opacity: 0; } }`;

          const globalState = globalThis as { marqueeStyleSheet?: HTMLStyleElement };
          if (!globalState.marqueeStyleSheet) {
            const sheet = document.createElement('style');
            document.head.appendChild(sheet);
            globalState.marqueeStyleSheet = sheet;
          }
          globalState.marqueeStyleSheet.textContent += keyframesCSS + firstRunKeyframesCSS;

          setArtistMarqueeConfig({ isActive: true, duration: travelSeconds, delay: initialDelay, fadeKeyframes: keyframesId });
          try {
            (inner as HTMLElement).dataset.marqueePause = String(pauseBetween);
            (inner as HTMLElement).dataset.fadeKeyframes = keyframesId;
            (inner as HTMLElement).dataset.fadeKeyframesFirst = firstRunKeyframesId;
            (inner as HTMLElement).dataset.travelDuration = String(travelSeconds);
          } catch {
            // ignore
          }
        } else {
          setArtistMarqueeConfig({ isActive: false, duration: 0, delay: 0 });
          try {
            (inner as HTMLElement).dataset.travelDuration = '0';
          } catch {
            // ignore
          }
        }
      });
    };

    check();
    const resizeObserver = new ResizeObserver(check);
    resizeObserver.observe(container);
    window.addEventListener('resize', check);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [effectiveArtist]);

  // Synchronize title and artist scrolling
  useEffect(() => {
    const titleInner = titleInnerRef.current;
    const artistInner = artistInnerRef.current;

    const titleDuration = parseFloat((titleInner as HTMLElement)?.dataset.travelDuration || '0');
    const artistDuration = parseFloat((artistInner as HTMLElement)?.dataset.travelDuration || '0');

    const bothActive = titleMarqueeConfig.isActive && artistMarqueeConfig.isActive;

    if (bothActive && titleDuration > 0 && artistDuration > 0) {
      // Use the maximum duration so both finish at the same time
      const maxDuration = Math.max(titleDuration, artistDuration);
      setSyncedDuration(maxDuration);
      // Trigger synchronized animation start
      setMarqueeSync(Date.now());
    } else if (titleMarqueeConfig.isActive && titleDuration > 0) {
      // Only title is scrolling
      setSyncedDuration(titleDuration);
      setMarqueeSync(Date.now());
    } else if (artistMarqueeConfig.isActive && artistDuration > 0) {
      // Only artist is scrolling
      setSyncedDuration(artistDuration);
      setMarqueeSync(Date.now());
    } else {
      setSyncedDuration(0);
    }
  }, [titleMarqueeConfig.isActive, titleMarqueeConfig.duration, artistMarqueeConfig.isActive, artistMarqueeConfig.duration]);

  // Artist scrolling animation
  useEffect(() => {
    const inner = artistInnerRef.current;
    if (!inner) return;

    artistHasPlayedRef.current = false;

    const clearTimers = () => {
      if (artistAnimationStartTimerRef.current) {
        window.clearTimeout(artistAnimationStartTimerRef.current);
        artistAnimationStartTimerRef.current = null;
      }
      if (artistAnimationPauseTimerRef.current) {
        window.clearTimeout(artistAnimationPauseTimerRef.current);
        artistAnimationPauseTimerRef.current = null;
      }
    };

    const pauseBetween = parseFloat((inner as HTMLElement).dataset.marqueePause || '1.5');

    const onEnd = () => {
      inner.style.removeProperty('animation');
      inner.style.removeProperty('transform');
      inner.style.opacity = '0';
      clearTimers();

      artistHasPlayedRef.current = true;

      const pauseMs = Math.round(pauseBetween * 1000);

      artistAnimationStartTimerRef.current = window.setTimeout(() => {
        const fadeKeyframes = (inner as HTMLElement).dataset.fadeKeyframes;
        const fadeKeyframesFirst = (inner as HTMLElement).dataset.fadeKeyframesFirst;
        const shouldFade = fadeKeyframes && artistHasPlayedRef.current;

        if (fadeKeyframes) {
          if (shouldFade) {
            inner.style.opacity = '0';
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
            });
          } else if (fadeKeyframesFirst) {
            inner.style.removeProperty('opacity');
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframesFirst} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
            });
          }
        }
      }, pauseMs);
    };

    artistAnimationListenerRef.current = onEnd;
    inner.addEventListener('animationend', onEnd as EventListener);

    clearTimers();
    inner.style.removeProperty('animation');
    inner.style.removeProperty('animation-fill-mode');
    inner.style.removeProperty('animation-iteration-count');
    inner.style.removeProperty('transform');
    inner.style.removeProperty('--marquee-travel');
    inner.style.removeProperty('opacity');

    if (artistMarqueeConfig.isActive && syncedDuration > 0) {
      inner.style.setProperty('--marquee-travel', `${syncedDuration}s`);
      const delayMs = Math.round(artistMarqueeConfig.delay * 1000);
      artistAnimationStartTimerRef.current = window.setTimeout(() => {
        const fadeKeyframes = artistMarqueeConfig.fadeKeyframes;
        const fadeKeyframesFirst = (inner as HTMLElement).dataset.fadeKeyframesFirst;
        const shouldFade = fadeKeyframes && artistHasPlayedRef.current;

        if (fadeKeyframes) {
          if (shouldFade) {
            inner.style.opacity = '0';
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframes} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
              const _forceReflow = inner.offsetWidth;
            });
          } else if (fadeKeyframesFirst) {
            inner.style.removeProperty('opacity');
            requestAnimationFrame(() => {
              const animationValue = `marquee-move var(--marquee-travel) linear, ${fadeKeyframesFirst} var(--marquee-travel) ease-in-out`;
              inner.style.animation = animationValue;
              inner.style.animationIterationCount = '1';
              inner.style.animationFillMode = 'both, both';
              const _forceReflow = inner.offsetWidth;
            });
          }
        }
      }, delayMs);
    }

    return () => {
      clearTimers();
      inner.removeEventListener('animationend', onEnd as EventListener);
      inner.style.removeProperty('--marquee-travel');
      inner.style.removeProperty('transform');
      inner.style.removeProperty('animation');
      inner.style.removeProperty('animation-iteration-count');
      inner.style.removeProperty('animation-fill-mode');
      inner.style.removeProperty('opacity');
      artistHasPlayedRef.current = false;
    };
  }, [artistMarqueeConfig.isActive, artistMarqueeConfig.delay, artistMarqueeConfig.fadeKeyframes, syncedDuration, marqueeSync, effectiveArtist]);

  // Create unique timestamp for each track change to force re-render even if image data is identical
  const [imageKeyTimestamp, setImageKeyTimestamp] = useState(0);

  useEffect(() => {
    setImageKeyTimestamp(Date.now());
  }, [snapshot?.props?.title, media?.title, snapshot?.source_app_id]);

  // Check lyrics availability when track changes
  useEffect(() => {
    const checkLyrics = async () => {
      if (!snapshot?.props?.title || !snapshot?.props?.artist) {
        setLyricsAvailable(false);
        setLyricsLoading(false);
        return;
      }

      setLyricsLoading(true);
      try {
        const result = await invoke<{ plainLyrics: string | null; syncedLyrics: string | null; instrumental: boolean }>('fetch_lyrics', {
          trackName: snapshot.props.title,
          artistName: snapshot.props.artist,
          albumName: snapshot.props.album_title,
          durationMs: snapshot.duration_ms,
        });
        // Only set available if synced lyrics exist
        setLyricsAvailable(!!result.syncedLyrics);
      } catch {
        setLyricsAvailable(false);
      } finally {
        setLyricsLoading(false);
      }
    };

    checkLyrics();
  }, [snapshot?.props?.title, snapshot?.props?.artist, snapshot?.props?.album_title, snapshot?.duration_ms]);

  const snapshotImage = effectiveSnapshot?.props?.album_image
    ? `data:image/png;base64,${effectiveSnapshot.props.album_image}`
    : null;

  const mediaImage = media?.album_image
    ? `data:image/png;base64,${media.album_image}`
    : null;

  // Prioritize snapshot image, use media image only as fallback when no snapshot is available
  const imageSrc = snapshotImage || mediaImage;

  const imageKey = `${effectiveSnapshot?.props?.title || media?.title || 'unknown'}-${imageKeyTimestamp}`;

  // Image key changes whenever track changes, forcing re-render

  const durationMs = snapshot?.duration_ms ?? null;
  const basePositionMs = snapshot?.position_ms ?? null;

  const isPlaying = snapshot?.is_playing ?? false;
  const isShuffle = snapshot?.is_shuffle ?? false;

  let effectivePositionMs = basePositionMs ?? 0;
  if (isPlaying && basePositionMs != null) {
    const advanced = basePositionMs + playElapsedMs;
    effectivePositionMs = Math.min(durationMs || Infinity, advanced);
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

  const handlePlayPause = () => {
    setPlayPauseImpact(true);
    setTimeout(() => setPlayPauseImpact(false), 300);
    sendControl('playPause', setTrackChangeDirection);
  };

  const handlePinToggle = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);

    // Create ripple effect with relative coordinates (button center)
    const newRipple = {
      id: Date.now(),
      x: rect.width / 2,
      y: rect.height / 2,
      size: size,
    };

    setRipples([newRipple]);
    setTimeout(() => setRipples([]), 600);
    setPinned((v) => !v);
  };

  const handleLyricOverlayToggle = async (e: MouseEvent<HTMLButtonElement>): Promise<void> => {
    const rect = e.currentTarget.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);

    // Create ripple effect with relative coordinates (button center)
    const newRipple = {
      id: Date.now(),
      x: rect.width / 2,
      y: rect.height / 2,
      size: size,
    };

    setLyricsRipples([newRipple]);
    setTimeout(() => setLyricsRipples([]), 600);

    try {
      if (!lyricsOverlayOpen) {
        // Create or show lyrics window
        const existingWindow = await WebviewWindow.getByLabel('lyrics');

        if (existingWindow) {
          await existingWindow.show();
          await existingWindow.setFocus();
        } else {
          const lyricsWindow = new WebviewWindow('lyrics', {
            url: '/lyrics',
            title: 'Lyrics provided by LRC Library',
            width: 408,
            height: 160,
            alwaysOnTop: true,
            resizable: false,
            decorations: false,
            visible: true,
            center: true,
            transparent: true,
            titleBarStyle: 'overlay',
            hiddenTitle: true,
          });

          // Configure window context menu after creation
          setTimeout(async () => {
            try {
              await lyricsWindow.show();
              await lyricsWindow.setFocus();
            } catch (err) {
              console.error('Error showing lyrics window:', err);
            }
          }, 100);

        }
        setLyricsOverlayOpen(true);
      } else {
        // Hide lyrics window
        const lyricsWindow = await WebviewWindow.getByLabel('lyrics');
        if (lyricsWindow) {
          await lyricsWindow.hide();
        }
        setLyricsOverlayOpen(false);
      }
    } catch (error) {
      console.error('Failed to toggle lyrics window:', error);
    }
  };

  const TitleComponent = (
    <div
      ref={titleContainerRef}
      className="flex-row text-lg font-semibold text-white w-full marquee-container"
      style={{
        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
        userSelect: 'none',
      } as never}
    >
      <span
        ref={titleInnerRef}
        className={'marquee-inner' + (titleMarqueeConfig.isActive ? ' marquee' : '')}
      >
        {effectiveTitle}
      </span>
    </div>
  );

  const ArtistComponent = (
    <div
      ref={artistContainerRef}
      className="flex-row text-sm text-white/80 w-full marquee-container"
      style={{
        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
        userSelect: 'none',
      } as never}
    >
      <span
        ref={artistInnerRef}
        className={'marquee-inner' + (artistMarqueeConfig.isActive ? ' marquee' : '')}
      >
        {effectiveArtist ?? 'Unknown Artist'}
      </span>
    </div>
  );

  return (
    <div
      className="w-screen h-screen flex items-center flex-start gap-1 flex-row px-2 py-1.5"
      style={{ background: 'rgba(0,0,0,0.75)', WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
    >

      {hasActiveMedia ? (
        <>
          <div
            key={`album-${animationKey}`}
            className={`flex items-center gap-1 ${isFading && appSwitchDirection
                ? appSwitchDirection === 'up'
                  ? 'app-slide-out-up opacity-30'
                  : 'app-slide-out-down opacity-30'
                : isFading
                  ? 'track-fading'
                  : appSwitchAnimating
                    ? appSwitchDirection === 'up'
                      ? 'app-slide-in-up'
                      : 'app-slide-in-down'
                    : isAnimating && trackChangeDirection
                      ? trackChangeDirection === 'previous'
                        ? 'track-slide-in-prev'
                        : 'track-slide-in-next'
                      : ''
              } ${frozenSnapshot && !isFading ? 'opacity-0' : ''}`}
          >
            <AlbumArt imageSrc={imageSrc} albumTitle={effectiveAlbumTitle} pinned={pinned} imageKey={imageKey} />
          </div>

          {/* Player icon - animated for app switches (opposite direction), outside animated wrapper so it doesn't reload on track change */}
          <StyledImage
            src={getPlayerInfo(frozenSnapshot?.source_app_id ?? sourceAppId).imageSrc}
            alt={getPlayerInfo(frozenSnapshot?.source_app_id ?? sourceAppId).name}
            className={`w-9 h-9 fixed bottom-1.5 left-1 ${isFading && appSwitchDirection
                ? appSwitchDirection === 'up'
                  ? 'app-slide-out-down opacity-30'
                  : 'app-slide-out-up opacity-30'
                : appSwitchAnimating
                  ? appSwitchDirection === 'up'
                    ? 'app-slide-in-down'
                    : 'app-slide-in-up'
                  : ''
              } ${frozenSnapshot && !isFading ? 'opacity-0' : ''}`}
            width={36}
            height={36}
            pinned={pinned}
            unoptimized
          />

          {/* Lyrics overlay button */}
          <button
            className={`w-9 h-9 fixed bottom-2.25 left-20 rounded-full flex items-center justify-center transition-colors overflow-hidden ${lyricsOverlayOpen
                ? 'bg-white hover:bg-white/80 text-black'
                : lyricsLoading
                  ? 'bg-black/60 text-white/60'
                  : lyricsAvailable
                    ? 'bg-black/60 hover:bg-black/70 text-white'
                    : 'bg-black/60 hover:bg-black/70 text-red-400'
              }`}
            onClick={handleLyricOverlayToggle}
            title={lyricsLoading ? 'Loading...' : lyricsAvailable ? 'Lyrics' : 'No lyrics available'}
            style={{ WebkitAppRegion: 'no-drag' } as never}
          >
            {lyricsLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ListMusic size={16} />
            )}
            {/* Ripple effects */}
            {lyricsRipples.map((ripple) => (
              <span
                key={ripple.id}
                className="absolute rounded-full bg-white/30 animate-ripple pointer-events-none"
                style={{
                  width: ripple.size * 2,
                  height: ripple.size * 2,
                  left: ripple.x - ripple.size,
                  top: ripple.y - ripple.size,
                  zIndex: 10,
                }}
              />
            ))}
          </button>

          <div
            className={`flex flex-col content-center justify-center shrink-0 transition-opacity duration-150 ${isFading && appSwitchDirection
                ? appSwitchDirection === 'up'
                  ? 'app-slide-out-up opacity-30'
                  : 'app-slide-out-down opacity-30'
                : isFading
                  ? 'opacity-30'
                  : appSwitchAnimating
                    ? appSwitchDirection === 'up'
                      ? 'app-slide-in-up'
                      : 'app-slide-in-down'
                    : isAnimating && trackChangeDirection
                      ? trackChangeDirection === 'previous'
                        ? 'track-slide-in-prev'
                        : 'track-slide-in-next'
                      : ''
              } ${frozenSnapshot && !isFading ? 'opacity-0' : ''}`}
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag', width: '280px', height: '128px', overflow: 'hidden' } as never}
          >
            {/* Container for media info and window controls */}
            <div className="flex flex-row justify-between">
              <MediaInfo
                title={TitleComponent}
                artist={ArtistComponent}
                pinned={pinned}
              />
              {/* Pin and Close buttons - top right corner */}
              <div className="flex flex-col content-start top-2 right-2.5 z-99" style={{ WebkitAppRegion: 'no-drag' } as never}>
                <WindowControls pinned={pinned} onPinToggle={handlePinToggle} ripples={ripples} />
              </div>
            </div>

            <MediaTimeline
              hasTimeline={!!hasTimeline}
              progress={progress}
              onProgressClick={handleProgressClick}
            />

            <MediaControls
              isPlaying={isPlaying}
              isShuffle={isShuffle}
              repeatMode={snapshot?.repeat_mode ?? 'none'}
              sourceAppId={sourceAppId}
              pinned={pinned}
              playPauseImpact={playPauseImpact}
              onPlayPause={handlePlayPause}
              onPrevious={() => sendControl('previous', setTrackChangeDirection, setIsFading)}
              onNext={() => sendControl('next', setTrackChangeDirection, setIsFading)}
              onShuffle={(value) => sendPlaybackMode('shuffle', value)}
              onRepeat={(mode) => sendPlaybackMode('repeat', mode)}
            />

          </div>
        </>
      ) : (
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
      <UpdateNotification />
    </div>
  );
}
