'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
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
import { getPlayerInfo, normalizeAppId } from './appInfo';
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
    console.warn('control_media failed', e);
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
    console.warn('sendPlaybackMode failed', e);
  }
}

async function sendSeek(positionMs: number) {
  try {
    await invoke('seek_to', { positionMs });
  } catch (e) {
    console.warn('seek_to failed', e);
  }
}

export default function OverlayPage() {
  const media = useMediaInfo();

  const [snapshot, setSnapshot] = useState<MediaSnapshotDto | null>(null);
  const currentSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const pendingSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const pendingAppSwitchSourceRef = useRef<string | null>(null);
  const pendingAppSwitchSourceHitsRef = useRef(0);
  const appSwitchingRef = useRef<boolean>(false);
  const [playElapsedMs, setPlayElapsedMs] = useState(0);
  const [pinned, setPinned] = useState(false);
  const dragRegionProps = pinned ? {} : { 'data-tauri-drag-region': '' };
  const [lyricsOverlayOpen, setLyricsOverlayOpen] = useState(false);
  const [lyricsAvailable, setLyricsAvailable] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const playbackLoadingTimeoutRef = useRef<number | null>(null);
  const appSwitchTimeoutRef = useRef<number | null>(null);

  // Track change animation state
  const [trackChangeDirection, setTrackChangeDirection] = useState<'next' | 'previous' | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [animationKey, setAnimationKey] = useState(0);
  const previousTitleRef = useRef<string | undefined>(undefined);
  const pendingTrackChangeRef = useRef<'next' | 'previous' | null>(null);
  const trackAnimationTimeoutRef = useRef<number | null>(null);

  // App switch animation state
  const [appSwitchDirection, setAppSwitchDirection] = useState<'up' | 'down' | null>(null);
  const [appSwitchAnimating, setAppSwitchAnimating] = useState(false);

  const lastSourceAppIdRef = useRef<string | null>(null);
  const [frozenSnapshot, setFrozenSnapshot] = useState<MediaSnapshotDto | null>(null);
  const previousSnapshotRef = useRef<MediaSnapshotDto | null>(null);
  const [appSwitchTrigger, setAppSwitchTrigger] = useState(0);
  const [lastVisibleSnapshot, setLastVisibleSnapshot] = useState<MediaSnapshotDto | null>(null);

  const APP_SWITCH_DEBOUNCE_MS = 220;
  const APP_SWITCH_FADE_MS = 160;
  const APP_SWITCH_SLIDE_MS = 240;

  // Play/pause impact animation
  const [playPauseImpact, setPlayPauseImpact] = useState(false);
  const previousPlayStateRef = useRef<boolean | undefined>(undefined);

  // Centralized ripple state for all overlay ripples
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);

  // Ref for overlay container
  const overlayRef = useRef<HTMLDivElement>(null);
  const currentWindowRef = useRef<any | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      currentWindowRef.current = getCurrentWindow();
    } catch {
      currentWindowRef.current = null;
    }
  }, []);

  // Always prevent the webview/contextmenu; when pinned, also prevent native menu
  useEffect(() => {
    const handleContextMenu = (e: Event) => {
      // Always prevent the in-webview/contextmenu from appearing
      e.preventDefault();
      // When pinned, also signal to prevent native menu via custom window procedure
      if (pinned) {
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
    invoke('refresh_media_snapshot').catch((e: any) =>
      console.warn('refresh_media_snapshot failed on mount', e)
    );

    listen<MediaSnapshotDto>('media_snapshot', (event) => {
      let nextPayload = event.payload;
      const newSourceAppId = event.payload.source_app_id ?? null;
      const currentSourceAppId = currentSnapshotRef.current?.source_app_id ?? null;
      const normalizedNewSourceAppId = normalizeAppId(newSourceAppId);
      const normalizedCurrentSourceAppId = normalizeAppId(currentSourceAppId);

      const previous = currentSnapshotRef.current;
      const trackChanged =
        !!previous &&
        previous.source_app_id === event.payload.source_app_id &&
        (previous.props.title !== event.payload.props.title ||
          previous.props.artist !== event.payload.props.artist ||
          previous.props.album_title !== event.payload.props.album_title);

      // Some players briefly report stale position from the previous song on natural
      // track transitions. Prevent temporary 100% progress and backward rewinds.
      if (trackChanged && event.payload.is_playing && event.payload.duration_ms && event.payload.duration_ms > 0) {
        const reportedPosition = event.payload.position_ms ?? 0;
        const ratio = reportedPosition / event.payload.duration_ms;
        if (reportedPosition > 0 && ratio > 0.35) {
          nextPayload = { ...event.payload, position_ms: 0 };
        }
      }

      if (appSwitchingRef.current && pendingSnapshotRef.current) {
        const pendingSourceAppId = normalizeAppId(
          pendingSnapshotRef.current.source_app_id ?? null
        );
        if (normalizedNewSourceAppId !== pendingSourceAppId) {
          return;
        }
      }

      // Check if this is an app switch.
      // Only consider it a real app switch when both sides have stable, non-empty
      // normalized IDs and they are different.
      const currentIsPlaying = currentSnapshotRef.current?.is_playing ?? false;
      const incomingIsPlaying = nextPayload.is_playing;
      const isAppSwitch =
        normalizedCurrentSourceAppId.length > 0 &&
        normalizedNewSourceAppId.length > 0 &&
        normalizedCurrentSourceAppId !== normalizedNewSourceAppId &&
        // Do not let a paused cross-source snapshot displace an actively playing source.
        !(currentIsPlaying && !incomingIsPlaying);

      if (isAppSwitch) {
        // Keep old and newest candidate snapshot until the switch is confirmed.
        previousSnapshotRef.current = currentSnapshotRef.current;
        pendingSnapshotRef.current = nextPayload;

        // Don't repeatedly reset the debounce for the same target app.
        // Continuous snapshots from the new player otherwise delay switching forever.
        const candidateChanged =
          pendingAppSwitchSourceRef.current !== normalizedNewSourceAppId;
        pendingAppSwitchSourceRef.current = normalizedNewSourceAppId;
        pendingAppSwitchSourceHitsRef.current = candidateChanged
          ? 1
          : pendingAppSwitchSourceHitsRef.current + 1;

        // When the current source is not playing but the incoming source is playing,
        // one cross-source snapshot is usually enough signal for a real app handoff.
        // Requiring two hits here can stall forever if position updates are sparse.
        const requiredCandidateHits = !currentIsPlaying && incomingIsPlaying ? 1 : 2;

        // Require at least 2 consecutive snapshots from the same candidate source
        // before arming the app-switch debounce. This filters one-off source blips.
        if (pendingAppSwitchSourceHitsRef.current < requiredCandidateHits) {
          console.debug('[App Switch Candidate]', {
            previousAppId: normalizedCurrentSourceAppId,
            candidateAppId: normalizedNewSourceAppId,
            hits: pendingAppSwitchSourceHitsRef.current,
            requiredHits: requiredCandidateHits,
            title: nextPayload.props.title,
            isPlaying: incomingIsPlaying,
            previousIsPlaying: currentIsPlaying,
          });
          return;
        }

        if (candidateChanged && appSwitchTimeoutRef.current !== null) {
          clearTimeout(appSwitchTimeoutRef.current);
          appSwitchTimeoutRef.current = null;
        }

        if (appSwitchTimeoutRef.current === null) {
          appSwitchTimeoutRef.current = window.setTimeout(() => {
            const pending = pendingSnapshotRef.current;
            const pendingSourceAppId = normalizeAppId(pending?.source_app_id ?? null);

            if (!pending || pendingSourceAppId !== pendingAppSwitchSourceRef.current) {
              appSwitchTimeoutRef.current = null;
              return;
            }

            console.log('[App Switch Detected]', {
              previousAppId: normalizedCurrentSourceAppId,
              newAppId: pendingSourceAppId,
              previousTitle: currentSnapshotRef.current?.props.title,
              newTitle: pending.props.title,
            });

            appSwitchingRef.current = true;
            setAppSwitchTrigger(prev => prev + 1);
            appSwitchTimeoutRef.current = null;
          }, APP_SWITCH_DEBOUNCE_MS);
        }

      } else {
        // Normal update - no app switch
        const crossSourceCandidate =
          normalizedCurrentSourceAppId.length > 0 &&
          normalizedNewSourceAppId.length > 0 &&
          normalizedCurrentSourceAppId !== normalizedNewSourceAppId;

        if (crossSourceCandidate) {
          console.debug('[App Switch Candidate Cancelled]', {
            previousAppId: normalizedCurrentSourceAppId,
            candidateAppId: normalizedNewSourceAppId,
            title: nextPayload.props.title,
            isPlaying: incomingIsPlaying,
            previousIsPlaying: currentIsPlaying,
            reason: currentIsPlaying && !incomingIsPlaying ? 'incoming-paused-while-current-playing' : 'did-not-pass-switch-criteria',
          });
        }

        // If a switch debounce was pending, this update invalidates it.
        if (appSwitchTimeoutRef.current !== null) {
          clearTimeout(appSwitchTimeoutRef.current);
          appSwitchTimeoutRef.current = null;
          pendingSnapshotRef.current = null;
          pendingAppSwitchSourceRef.current = null;
          pendingAppSwitchSourceHitsRef.current = 0;
          appSwitchingRef.current = false;
        }

        // Debounce updates that lack title information to avoid flashing "no media playing"
        const incomingTitle = nextPayload.props?.title;

        if (!incomingTitle) {
          // Start or restart the playback-loading debounce
          if (playbackLoadingTimeoutRef.current !== null) {
            clearTimeout(playbackLoadingTimeoutRef.current);
            playbackLoadingTimeoutRef.current = null;
          }

          // If an app-switch debounce was pending, cancel it — this normal update supersedes it
          if (appSwitchTimeoutRef.current !== null) {
            clearTimeout(appSwitchTimeoutRef.current);
            appSwitchTimeoutRef.current = null;
            pendingSnapshotRef.current = null;
            pendingAppSwitchSourceRef.current = null;
            pendingAppSwitchSourceHitsRef.current = 0;
            appSwitchingRef.current = false;
          }

          setPlaybackLoading(true);

          playbackLoadingTimeoutRef.current = window.setTimeout(() => {
            previousSnapshotRef.current = currentSnapshotRef.current;
            currentSnapshotRef.current = nextPayload;
            setSnapshot(nextPayload);
            setPlaybackLoading(false);
            playbackLoadingTimeoutRef.current = null;
          }, 3000);
        } else {
          // Valid title arrived — cancel any pending debounce and show immediately
          if (playbackLoadingTimeoutRef.current !== null) {
            clearTimeout(playbackLoadingTimeoutRef.current);
            playbackLoadingTimeoutRef.current = null;
          }

          previousSnapshotRef.current = currentSnapshotRef.current;
          currentSnapshotRef.current = nextPayload;
          setSnapshot(nextPayload);
          setPlaybackLoading(false);
        }

        // Emit event for lyrics window
        emit('media-updated', {
          title: nextPayload.props.title,
          artist: nextPayload.props.artist,
          albumTitle: nextPayload.props.album_title,
          durationMs: nextPayload.duration_ms,
          positionMs: nextPayload.position_ms,
        });

        // If this is the first snapshot and position seems incorrect (null or 0) while playing,
        // request a refresh after a short delay to get accurate position
        if (!currentSnapshotRef.current &&
          nextPayload.is_playing &&
          nextPayload.duration_ms &&
          nextPayload.duration_ms > 0 &&
          (!nextPayload.position_ms || nextPayload.position_ms === 0)) {
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
      if (playbackLoadingTimeoutRef.current !== null) {
        clearTimeout(playbackLoadingTimeoutRef.current);
        playbackLoadingTimeoutRef.current = null;
      }
      if (appSwitchTimeoutRef.current !== null) {
        clearTimeout(appSwitchTimeoutRef.current);
        appSwitchTimeoutRef.current = null;
      }
      pendingAppSwitchSourceRef.current = null;
      pendingAppSwitchSourceHitsRef.current = 0;
      appSwitchingRef.current = false;
    };
  }, []);

  useEffect(() => {
    const window = getCurrentWindow();
    let unlistenFocusChanged: (() => void) | undefined;

    window.setAlwaysOnTop(true).catch((e) => {
      console.warn('setAlwaysOnTop failed', e);
    });

    window.setSize(new LogicalSize(408, 128)).catch((e) => {
      console.warn('setSize failed', e);
    });

    window.setShadow(false).catch(() => {
      // Unsupported on Linux; ignore.
    });

    const reassertTopmost = () => {
      window.setAlwaysOnTop(true).catch(() => {
        // Best effort on Linux window managers.
      });
    };

    window.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        reassertTopmost();
      }
    }).then((unlisten: any) => {
      unlistenFocusChanged = unlisten;
    }).catch(() => {
      // Ignore if unavailable.
    });

    document.addEventListener('visibilitychange', reassertTopmost);

    return () => {
      document.removeEventListener('visibilitychange', reassertTopmost);
      unlistenFocusChanged?.();
    };
  }, []);

  useEffect(() => {
    if (!snapshot?.is_playing || !snapshot?.duration_ms || snapshot.duration_ms <= 0) {
      return;
    }

    // Re-anchor to the backend-reported position whenever playback state/position changes.
    // This prevents local elapsed accumulation from drifting across snapshot updates.
    setPlayElapsedMs(0);

    let frameId: number;
    let last = performance.now();
    let lastPaintTime = 0;
    const durationMs = snapshot.duration_ms;
    const positionMs = snapshot.position_ms ?? 0;
    let lastEmitTime = 0;
    let elapsedMs = 0;
    const paintIntervalMs = 33;

    const tick = (now: number) => {
      const deltaMs = now - last;
      last = now;

      const maxElapsed = Math.max(0, durationMs - positionMs);
      elapsedMs = Math.min(elapsedMs + deltaMs, maxElapsed);

      // Throttle React state updates for smoother, less jittery rendering under load.
      if (now - lastPaintTime >= paintIntervalMs || elapsedMs >= maxElapsed) {
        setPlayElapsedMs(elapsedMs);
        lastPaintTime = now;
      }

      // Emit position update to lyrics window every 100ms
      if (now - lastEmitTime >= 100) {
        emit('playback-position', { positionMs: positionMs + elapsedMs });
        lastEmitTime = now;
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [snapshot?.is_playing, snapshot?.duration_ms, snapshot?.position_ms]);

  const sourceAppId = snapshot?.source_app_id ?? null;

  useEffect(() => {
    const current = normalizeAppId(snapshot?.source_app_id ?? null);
    if (lastSourceAppIdRef.current !== current && lastSourceAppIdRef.current !== null) {
      // App switched - force a refresh to get updated snapshot from new app
      invoke('refresh_media_snapshot').catch((e: any) =>
        console.warn('refresh_media_snapshot failed on app switch', e)
      );
      lastSourceAppIdRef.current = current;
    } else if (lastSourceAppIdRef.current === null) {
      // First initialization
      lastSourceAppIdRef.current = current;
    }
  }, [snapshot?.source_app_id]);

  useEffect(() => {
    const candidate = frozenSnapshot ?? snapshot;
    // Only update the "last visible" snapshot when the UI is in a stable state.
    // Avoid updating while animations, app-switch transitions, or playback-loading
    // are in progress, otherwise the fallback image can be overwritten too early.
    if (candidate?.props?.title && !playbackLoading && !isAnimating && !isFading && !appSwitchAnimating) {
      setLastVisibleSnapshot(candidate);
    }
  }, [frozenSnapshot, snapshot, playbackLoading, isAnimating, isFading, appSwitchAnimating]);

  const displaySnapshot = useMemo(() => {
    const candidate = frozenSnapshot ?? snapshot;
    if (candidate?.props?.title) {
      return candidate;
    }

    if (playbackLoading || isAnimating || isFading || appSwitchAnimating) {
      return lastVisibleSnapshot;
    }

    return candidate;
  }, [frozenSnapshot, snapshot, playbackLoading, isAnimating, isFading, appSwitchAnimating, lastVisibleSnapshot]);

  const hasSnapshotTitle = !!displaySnapshot?.props?.title;
  const hasMediaTitle = !!media?.title;
  const hasActiveMedia = hasSnapshotTitle || hasMediaTitle;

  const effectiveTitle = useMemo(
    () => displaySnapshot?.props?.title || media?.title,
    [displaySnapshot, media?.title]
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
      // Clear spinner if pending next/previous
      if (pendingTrackChangeRef.current) {
        setPlaybackLoading(false);
        pendingTrackChangeRef.current = null;
        if (playbackLoadingTimeoutRef.current !== null) {
          clearTimeout(playbackLoadingTimeoutRef.current);
          playbackLoadingTimeoutRef.current = null;
        }
      }

      // Log snapshot progress values for debugging

      if (snapshot) {
        // eslint-disable-next-line no-console
        console.log('[Track Change Detected]', {
          prevTitle: previousTitleRef.current,
          newTitle: currentTitle,
          position_ms: snapshot.position_ms,
          duration_ms: snapshot.duration_ms,
          is_playing: snapshot.is_playing,
        });

        // Workaround: If position_ms is unusually high after a track change,
        // keep UI timeline from jumping to 100% for this frame.
        const duration = snapshot.duration_ms || 0;
        const position = snapshot.position_ms || 0;
        // Consider >10% of duration or >5s as suspicious for a new track
        if (
          duration > 0 &&
          position > 0 &&
          (position > duration * 0.1 || position > 5000)
        ) {          
          console.warn('[Track Change Workaround] Unusually high position_ms after track change, using local reset for this frame.', { position, duration });
        }
      }

      // If no direction was set (external control), default to 'next'
      if (!trackChangeDirection) {
        setTrackChangeDirection('next');
      }

      // Clear fading and start slide animation
      setIsFading(false);

      // Increment key to force animation retrigger
      setAnimationKey(prev => prev + 1);
      setIsAnimating(true);

      // Clear animation state after it completes.
      if (trackAnimationTimeoutRef.current !== null) {
        clearTimeout(trackAnimationTimeoutRef.current);
        trackAnimationTimeoutRef.current = null;
      }
      trackAnimationTimeoutRef.current = window.setTimeout(() => {
        setIsAnimating(false);
        setTrackChangeDirection(null); // Clear direction after animation
        // Reset playElapsedMs after animation to sync with new track
        setPlayElapsedMs(0);
        trackAnimationTimeoutRef.current = null;
      }, 350); // Slightly longer than animation duration to ensure completion

      previousTitleRef.current = currentTitle;
    } else if (currentTitle) {
      previousTitleRef.current = currentTitle;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTitle, trackChangeDirection, appSwitchDirection]);

  useEffect(() => {
    return () => {
      if (trackAnimationTimeoutRef.current !== null) {
        clearTimeout(trackAnimationTimeoutRef.current);
        trackAnimationTimeoutRef.current = null;
      }
    };
  }, []);

  // Detect app switches (sourceAppId changes)
  useEffect(() => {
    // Check if we have a pending snapshot (app switch happened in listener)
    if (pendingSnapshotRef.current) {
      const newSourceAppId = pendingSnapshotRef.current.source_app_id ?? null;
      const currentSourceAppId = currentSnapshotRef.current?.source_app_id ?? null;

      // Keep switch direction deterministic. Alphabetical ordering made transitions feel random.
      const direction: 'up' | 'down' = currentSourceAppId === newSourceAppId ? 'up' : 'down';

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
      }, APP_SWITCH_FADE_MS);

      // Clean up animation states
      const cleanupTimer = setTimeout(() => {
        setIsAnimating(false);
        setAppSwitchAnimating(false);
        setAppSwitchDirection(null);
        setPlayElapsedMs(0);
        pendingSnapshotRef.current = null; // Clear it here after full animation
        pendingAppSwitchSourceRef.current = null;
        pendingAppSwitchSourceHitsRef.current = 0;
        appSwitchingRef.current = false;
      }, APP_SWITCH_FADE_MS + APP_SWITCH_SLIDE_MS + 30);

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
      setPlaybackLoading(false);
    }

    previousPlayStateRef.current = currentPlayState;
  }, [snapshot?.is_playing]);

  // Keep all animated media visuals tied to one snapshot so text/art/app badge stay in sync.
  const effectiveSnapshot = useMemo(() => {
    if (isFading) {
      return frozenSnapshot ?? previousSnapshotRef.current ?? displaySnapshot;
    }
    if (appSwitchAnimating) {
      return snapshot ?? pendingSnapshotRef.current ?? displaySnapshot;
    }
    return displaySnapshot;
  }, [isFading, appSwitchAnimating, frozenSnapshot, snapshot, displaySnapshot]);

  const hasPendingAppSwitchCandidate =
    !!pendingSnapshotRef.current &&
    normalizeAppId(pendingSnapshotRef.current.source_app_id ?? null) !==
      normalizeAppId(currentSnapshotRef.current?.source_app_id ?? null);

  const visualTitle = useMemo(
    () => effectiveSnapshot?.props?.title || media?.title,
    [effectiveSnapshot, media?.title]
  );

  // Only use media fallback if title hasn't changed (same song); otherwise use snapshot values only
  const shouldUseFallback = effectiveTitle === lastTitle;
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
      inner.style.removeProperty('opacity');
      artistHasPlayedRef.current = false;
    };
  }, [artistMarqueeConfig.isActive, artistMarqueeConfig.delay, artistMarqueeConfig.fadeKeyframes, syncedDuration, marqueeSync, effectiveArtist]);

  // Create unique timestamp for each track change to force re-render even if image data is identical
  const [imageKeyTimestamp, setImageKeyTimestamp] = useState(0);

  useEffect(() => {
    // Avoid forcing an image remount while an app-switch animation is in progress.
    // When switching apps we prefer to keep the previous/frozen image visible until
    // the transition completes.
    if (!appSwitchingRef.current && !isFading && !appSwitchAnimating) {
      setImageKeyTimestamp(Date.now());
    }
  }, [snapshot?.props?.title, snapshot?.source_app_id, isFading, appSwitchAnimating]);

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

  const isAppSwitchTransition =
    appSwitchingRef.current || isFading || appSwitchAnimating || hasPendingAppSwitchCandidate;
  const mediaMatchesSnapshot =
    !!media &&
    !!effectiveSnapshot &&
    media.title === effectiveSnapshot.props.title &&
    media.artist === effectiveSnapshot.props.artist &&
    (media.album_title ?? null) === (effectiveSnapshot.props.album_title ?? null);
  // During app-switch transitions do not mix in media fallback from a different source.
  const imageSrc = snapshotImage || (!isAppSwitchTransition && mediaMatchesSnapshot ? mediaImage : null);

  useEffect(() => {
    if (!snapshotImage && mediaImage && !mediaMatchesSnapshot) {
      console.debug('[Album Art Fallback Blocked]', {
        snapshotTitle: effectiveSnapshot?.props.title,
        snapshotArtist: effectiveSnapshot?.props.artist,
        mediaTitle: media?.title,
        mediaArtist: media?.artist,
        source: normalizeAppId(effectiveSnapshot?.source_app_id ?? sourceAppId),
      });
    }
  }, [snapshotImage, mediaImage, mediaMatchesSnapshot, effectiveSnapshot?.props.title, effectiveSnapshot?.props.artist, effectiveSnapshot?.source_app_id, media?.title, media?.artist, sourceAppId]);

  const imageKey = `${effectiveSnapshot?.props?.title || 'unknown'}-${imageKeyTimestamp}`;

  // Image key changes whenever track changes, forcing re-render

  const durationMs = snapshot?.duration_ms ?? null;
  const rawBasePositionMs = snapshot?.position_ms ?? null;
  const basePositionMs =
    rawBasePositionMs != null
      ? Math.max(0, Math.min(rawBasePositionMs, durationMs ?? rawBasePositionMs))
      : null;

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

    if (playbackLoadingTimeoutRef.current !== null) {
      clearTimeout(playbackLoadingTimeoutRef.current);
      playbackLoadingTimeoutRef.current = null;
    }
    setPlaybackLoading(true);
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, x / rect.width));
    const targetMs = Math.round(durationMs * fraction);
    sendSeek(targetMs);
    playbackLoadingTimeoutRef.current = window.setTimeout(() => {
      setPlaybackLoading(false);
      playbackLoadingTimeoutRef.current = null;
    }, 300);
  };

  // Helper to show loading spinner for next/previous
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handlePrevious = (e: MouseEvent<HTMLButtonElement>) => {
    setPlaybackLoading(true);
    pendingTrackChangeRef.current = 'previous';
    sendControl('previous', setTrackChangeDirection, setIsFading);
    // If track doesn't change within 500ms, clear spinner
    playbackLoadingTimeoutRef.current = window.setTimeout(() => {
      if (pendingTrackChangeRef.current === 'previous') {
        setPlaybackLoading(false);
        pendingTrackChangeRef.current = null;
        playbackLoadingTimeoutRef.current = null;
      }
    }, 500);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleNext = (e: MouseEvent<HTMLButtonElement>) => {
    setPlaybackLoading(true);
    pendingTrackChangeRef.current = 'next';
    sendControl('next', setTrackChangeDirection, setIsFading);
    // Spinner will be cleared on track change
  };

  const triggerRipple = (e: MouseEvent<HTMLButtonElement>) => {
    if (!overlayRef.current) return;
    const buttonRect = e.currentTarget.getBoundingClientRect();
    const overlayRect = overlayRef.current.getBoundingClientRect();
    const size = Math.max(buttonRect.width, buttonRect.height);
    // Calculate center of button relative to overlay
    const x = (buttonRect.left + buttonRect.width / 2) - overlayRect.left;
    const y = (buttonRect.top + buttonRect.height / 2) - overlayRect.top;
    const ripple = {
      id: Date.now() + Math.random(),
      x,
      y,
      size,
    };
    setRipples((prev) => [...prev, ripple]);
  };

  // Helper to wrap button handlers to also trigger ripple
  // Type-safe ripple wrapper for button event handlers
  const withRipple = (handler: (e: MouseEvent<HTMLButtonElement>) => void) => (e: MouseEvent<HTMLButtonElement>) => {
    triggerRipple(e);
    handler(e);
  };

  const handlePlayPause = (_e: MouseEvent<HTMLButtonElement>) => {
    setPlayPauseImpact(true);
    setTimeout(() => setPlayPauseImpact(false), 300);
    sendControl('playPause', setTrackChangeDirection);
  };

  const handlePinToggle = (e: MouseEvent<HTMLButtonElement>) => {
    setPinned((v) => !v);
    triggerRipple(e);
  };

  const handleWindowDragStart = (e: React.MouseEvent<HTMLElement>) => {
    if (pinned || e.button !== 0) {
      return;
    }

    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [data-no-drag]')) {
      return;
    }

    if (currentWindowRef.current) {
      currentWindowRef.current.startDragging().catch((error: any) => {
        console.warn('startDragging failed', error);
      });
    }
  };

  const handleLyricOverlayToggle = async (e: MouseEvent<HTMLButtonElement>): Promise<void> => {
    triggerRipple(e);

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
            height: 200,
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
              console.warn('Error showing lyrics window:', err);
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
      console.warn('Failed to toggle lyrics window:', error);
    }
  };

  const TitleComponent = (
    <div
      ref={titleContainerRef}
      className="flex-row text-lg font-semibold text-white w-full marquee-container"
      {...dragRegionProps}
      style={{ userSelect: 'none' } as never}
    >
      <span
        ref={titleInnerRef}
        className={'marquee-inner' + (titleMarqueeConfig.isActive ? ' marquee' : '')}
      >
        {visualTitle}
      </span>
    </div>
  );

  const ArtistComponent = (
    <div
      ref={artistContainerRef}
      className="flex-row text-sm text-white/80 w-full marquee-container"
      {...dragRegionProps}
      style={{ userSelect: 'none' } as never}
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
    <div className="w-full h-full" style={{ background: 'transparent', userSelect: 'none', } as never}>
      <div
        ref={overlayRef}
        key="main-overlay-container"
        className="relative flex h-full w-full rounded-lg border border-white/10"
        onMouseDown={handleWindowDragStart}
        style={{
          background: 'rgba(8,8,8,0.82)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',          
        } as never}
      >
        {/* Background ripples */}
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            className="absolute rounded-full bg-white/30 animate-ripple pointer-events-none"
            style={{
              width: ripple.size * 2,
              height: ripple.size * 2,
              left: ripple.x - ripple.size,
              top: ripple.y - ripple.size,
              zIndex: 0,
            }}
            onAnimationEnd={() => setRipples((prev) => prev.filter(r => r.id !== ripple.id))}
          />
        ))}

        {hasActiveMedia ? (
          <div className="relative z-10 flex h-full w-full items-center gap-3 px-3 py-2.5">
            <div
              className={`relative flex h-full w-26 shrink-0 items-center justify-center ${isFading && appSwitchDirection
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
              key={`album-${animationKey}`}
              {...dragRegionProps}
            >
              <AlbumArt imageSrc={imageSrc} albumTitle={effectiveAlbumTitle} pinned={pinned} imageKey={imageKey} />

              <StyledImage
                src={getPlayerInfo(effectiveSnapshot?.source_app_id ?? sourceAppId).imageSrc}
                alt={getPlayerInfo(effectiveSnapshot?.source_app_id ?? sourceAppId).name}
                className={`absolute -bottom-[0.5vh] -left-[1.5vw] h-8 w-8 p-1 shadow-lg ${isFading && appSwitchDirection
                  ? appSwitchDirection === 'up'
                    ? 'app-slide-out-down opacity-30'
                    : 'app-slide-out-up opacity-30'
                  : appSwitchAnimating
                    ? appSwitchDirection === 'up'
                      ? 'app-slide-in-down'
                      : 'app-slide-in-up'
                    : ''
                  } ${frozenSnapshot && !isFading ? 'opacity-0' : ''}`}
                width={32}
                height={32}
                pinned={pinned}
                unoptimized
              />

              <button
                className={`absolute -bottom-[0.5vh] -right-[1.5vw] flex h-8 w-8 items-center justify-center rounded-full transition-colors overflow-hidden ${lyricsOverlayOpen
                  ? lyricsAvailable 
                    ? 'bg-white hover:bg-white/80 text-black' 
                    : 'bg-white hover:bg-white/80 text-red-800'
                  : lyricsLoading
                    ? 'bg-black/60 text-white/60'
                    : lyricsAvailable
                      ? 'bg-black/60 hover:bg-black/70 text-white'
                      : 'bg-black/60 hover:bg-black/70 text-red-400'
                  }`}
                onClick={handleLyricOverlayToggle}
                title={lyricsLoading ? 'Loading...' : lyricsAvailable ? 'Lyrics' : 'No lyrics available'}
                data-no-drag
              >
                {lyricsLoading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <ListMusic size={16} />
                )}
              </button>
            </div>

            <div
              className={`flex min-w-0 flex-1 flex-col justify-between transition-opacity duration-150 ${isFading && appSwitchDirection
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
                style={{ minHeight: '100%' } as never}
            >
              <div className="flex items-start justify-between gap-3">
                <MediaInfo
                  title={TitleComponent}
                  artist={ArtistComponent}
                  pinned={pinned}
                />
                <div className="shrink-0" data-no-drag>
                  <WindowControls pinned={pinned} onPinToggle={handlePinToggle} />
                </div>
              </div>

              <div className="mt-0">
                <MediaTimeline
                  hasTimeline={!!hasTimeline}
                  progress={progress}
                  onProgressClick={handleProgressClick}
                />
              </div>

              <div className="mt-0">
                <MediaControls
                  isPlaying={isPlaying}
                  isShuffle={isShuffle}
                  repeatMode={snapshot?.repeat_mode ?? 'none'}
                  sourceAppId={effectiveSnapshot?.source_app_id ?? sourceAppId}
                  pinned={pinned}
                  playPauseImpact={playPauseImpact}
                  playbackLoading={playbackLoading}
                  onPlayPause={withRipple(handlePlayPause)}
                  onPrevious={withRipple(handlePrevious)}
                  onNext={withRipple(handleNext)}
                  onShuffle={withRipple(() => sendPlaybackMode('shuffle', !isShuffle))}
                  onRepeat={withRipple(() => {
                    const current = snapshot?.repeat_mode ?? 'none';
                    let next: 'none' | 'list' | 'track';
                    if (current === 'none') next = 'list';
                    else if (current === 'list') next = 'track';
                    else next = 'none';
                    sendPlaybackMode('repeat', next);
                  })}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="relative z-10 flex h-full w-full flex-col px-3 py-2.5">
            <div className="flex justify-end z-99" {...dragRegionProps}>
              <WindowControls pinned={pinned} onPinToggle={handlePinToggle} />
            </div>
            <div className="flex flex-1 flex-col items-center justify-center text-center py-2 -mt-6" {...dragRegionProps}>
              <div className="text-sm font-medium text-white/70">
                🔇 No media is currently playing 🔇
              </div>
              <div className="mt-1 text-xs text-white/45">
                🎵 Start playback in your favorite player to see controls here 🎶
              </div>
            </div>
          </div>
        )}
        <UpdateNotification />
      </div>
    </div>
  );
}
