'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, MouseEvent, useRef } from 'react';
import { WindowControls } from '../WindowControls';

interface LyricsData {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
}

interface LyricsLine {
  timestamp: number; // milliseconds
  text: string;
}

interface MediaUpdatePayload {
  title: string;
  artist: string;
  albumTitle?: string | null;
  durationMs?: number | null;
  positionMs?: number | null;
}

// Add CSS keyframe animations
const styles = `
  @keyframes lyric-activate {
    0% {
      opacity: 0.3;
      transform: scale(1) translateY(0);
    }
    50% {
      opacity: 0.7;
      transform: scale(1.04) translateY(-0.5px);
    }
    100% {
      opacity: 1;
      transform: scale(1.08) translateY(-1px);
    }
  }

  @keyframes lyric-deactivate {
    0% {
      opacity: 1;
      transform: scale(1.08) translateY(-1px);
    }
    100% {
      opacity: 0.3;
      transform: scale(1) translateY(0);
    }
  }

  .lyric-line-active {
    animation: lyric-activate 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }

  .lyric-line-inactive {
    animation: lyric-deactivate 0.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
`;

export default function LyricsPage() {
  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [parsedLyrics, setParsedLyrics] = useState<LyricsLine[]>([]);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Centralized ripple state for all overlay ripples
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [lastFetchParams, setLastFetchParams] = useState<{ title: string; artist: string; album?: string | null; duration?: number | null } | null>(null);

  // Parse LRC format synced lyrics
  const parseSyncedLyrics = (syncedLyrics: string): LyricsLine[] => {
    const lines: LyricsLine[] = [];
    const lrcRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;

    let match;
    while ((match = lrcRegex.exec(syncedLyrics)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const centiseconds = match[3].length === 2 ? parseInt(match[3], 10) : parseInt(match[3], 10) / 10;
      const timestamp = (minutes * 60 + seconds) * 1000 + centiseconds * 10;
      const text = match[4].trim();

      lines.push({ timestamp, text });
    }

    return lines.sort((a, b) => a.timestamp - b.timestamp);
  };

  const handleClose = async () => {
    const window = getCurrentWindow();
    await emit('lyrics-window-closed');
    await window.close();
  };

  const fetchLyrics = async (title: string, artist: string, albumTitle?: string | null, durationMs?: number | null) => {
    setLoading(true);
    setError(null);
    setCanRetry(false);

    try {
      const result = await invoke<LyricsData>('fetch_lyrics', {
        trackName: title,
        artistName: artist,
        albumName: albumTitle,
        durationMs,
      });

      setLyrics(result);

      if (result.syncedLyrics) {
        setParsedLyrics(parseSyncedLyrics(result.syncedLyrics));
      } else {
        setParsedLyrics([]);
      }
    } catch (e) {
      const errorMsg = String(e);

      // Only show user-friendly errors to the user
      if (errorMsg.includes('No lyrics found') || errorMsg.includes('No synced lyrics')) {
        // 404 - not an error, just no lyrics available (silently handle)
        setError('No synced lyrics available');
        setCanRetry(false);
      } else if (errorMsg.includes('timeout') || errorMsg.includes('connect')) {
        console.warn('Lyrics fetch warning:', errorMsg);
        setError('Connection failed');
        setCanRetry(true);
      } else if (errorMsg.includes('Rate limit')) {
        console.warn('Lyrics fetch warning:', errorMsg);
        setError('Rate limited. Please wait.');
        setCanRetry(true);
      } else {
        // Generic errors - don't show to user, just log
        console.error('Lyrics fetch error:', errorMsg);
        setError('Unable to load lyrics');
        setCanRetry(true);
      }

      setLyrics(null);
      setParsedLyrics([]);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = () => {
    if (lastFetchParams) {
      fetchLyrics(
        lastFetchParams.title,
        lastFetchParams.artist,
        lastFetchParams.album,
        lastFetchParams.duration
      );
    }
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
    setTimeout(() => setRipples((prev) => prev.filter(r => r.id !== ripple.id)), 600);
  };

  const handlePinToggle = async (e: MouseEvent<HTMLButtonElement>) => {
    triggerRipple(e);
    setPinned(!pinned);
  };

  // Handle context menu prevention
  useEffect(() => {
    const window = getCurrentWindow();
    invoke('configure_window_menu', { window });
  }, []);

  // Always prevent webview context menu (native Windows menu with Move/Close will show instead)
  useEffect(() => {
    const handleContextMenu = async (e: Event) => {
      // Always prevent webview menu
      e.preventDefault();
      // When pinned, also prevent native menu via the custom window procedure
      if (pinned) {
        return false;
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, [pinned]);

  useEffect(() => {
    let unlistenMedia: (() => void) | null = null;
    let unlistenPosition: (() => void) | null = null;
    let currentTrackKey = '';

    const setupListeners = async () => {
      // Listen for media changes to refetch lyrics
      unlistenMedia = await listen<MediaUpdatePayload>('media-updated', async (event) => {
        const { title, artist, albumTitle, durationMs } = event.payload;
        const trackKey = `${artist}|${title}`;

        // Only fetch if the track actually changed
        if (trackKey === currentTrackKey) {
          return;
        }

        currentTrackKey = trackKey;
        setLastFetchParams({ title, artist, album: albumTitle, duration: durationMs });
        await fetchLyrics(title, artist, albumTitle, durationMs);
      });

      // Listen for position updates
      unlistenPosition = await listen<{ positionMs: number }>('playback-position', (event) => {
        setCurrentPosition(event.payload.positionMs);
      });

      // Request initial media info
      try {
        await invoke('refresh_media_snapshot');
      } catch (e) {
        console.error('Failed to refresh media snapshot:', e);
      }
    };

    setupListeners();

    return () => {
      if (unlistenMedia) unlistenMedia();
      if (unlistenPosition) unlistenPosition();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderLyrics = () => {
    if (loading) {
      return (
        <div className="flex flex-col justify-center h-full px-6 space-y-1.5">
          <div className="h-4 bg-white/10 rounded animate-pulse mx-auto w-3/4"></div>
          <div className="h-5 bg-white/20 rounded animate-pulse mx-auto w-5/6"></div>
          <div className="h-4 bg-white/10 rounded animate-pulse mx-auto w-3/4"></div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-white/60 px-4 text-center space-y-3">
          <p className="text-base">{error}</p>
          {canRetry && (
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-full text-sm text-white transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      );
    }

    if (!lyrics) {
      return (
        <div className="flex items-center justify-center h-full text-white/60">
          No media playing
        </div>
      );
    }

    if (lyrics.instrumental) {
      return (
        <div className="flex items-center justify-center h-full text-white/60">
          ♪ Instrumental ♪
        </div>
      );
    }

    // Show synced lyrics if available
    if (parsedLyrics.length > 0) {
      // Show lyrics slightly ahead of actual position for better reading experience
      const LYRICS_OFFSET_MS = 250;
      const adjustedPosition = currentPosition + LYRICS_OFFSET_MS;
      // Find current line index
      const currentIndex = parsedLyrics.findIndex((line, idx) => {
        const nextLine = parsedLyrics[idx + 1];
        return adjustedPosition >= line.timestamp && (!nextLine || adjustedPosition < nextLine.timestamp);
      });

      // Show previous, current, and next lines
      const startIdx = Math.max(0, currentIndex - 1);
      const endIdx = Math.min(parsedLyrics.length, currentIndex + 2);
      const visibleLines = parsedLyrics.slice(startIdx, endIdx);

      return (
        <div className="flex flex-col justify-center h-full px-6 space-y-1.5">
          {visibleLines.map((line, idx) => {
            const actualIdx = startIdx + idx;
            const nextLine = parsedLyrics[actualIdx + 1];
            const isActive = adjustedPosition >= line.timestamp && (!nextLine || adjustedPosition < nextLine.timestamp);

            return (
              <div
                key={actualIdx}
                className={`text-center leading-tight text-[15px] ${isActive ? 'lyric-line-active' : 'lyric-line-inactive'
                  }`}
                style={{
                  color: isActive ? 'rgba(255, 255, 255, 1)' : 'rgba(255, 255, 255, 0.3)',
                  fontWeight: isActive ? 600 : 400,
                  textShadow: isActive ? '0 0 12px rgba(255, 255, 255, 0.3)' : 'none',
                }}
              >
                {line.text || '♪'}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center h-full text-white/60">
        No synced lyrics available
      </div>
    );
  };

  return (
    <>
      <style>{styles}</style>
      <div
        ref={overlayRef}
        className="w-screen h-screen flex flex-col relative overflow-hidden"
        style={{ background: 'rgba(0,0,0,0.85)', userSelect: 'none' } as never}
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
          />
        ))}
        {/* Header with controls */}
        <div
          className="flex items-center justify-between px-3 py-2.5 border-b border-white/10"
          style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
        >
          <div className="text-white/60 text-sm font-medium">
            <span>Lyrics provided by </span>
            <a
              href="https://lrclib.net"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-bold text-white"
              style={{ WebkitAppRegion: 'no-drag' } as never}
              title="https://lrclib.net"
            >
              LRC Library
            </a>
          </div>
          <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as never}>
            <WindowControls pinned={pinned} onPinToggle={handlePinToggle} onClose={handleClose} />
          </div>
        </div>

        {/* Lyrics content */}
        <div className="flex-1 overflow-hidden" style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}>
          {renderLyrics()}
        </div>
      </div>
    </>
  );
}
