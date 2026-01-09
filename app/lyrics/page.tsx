'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, MouseEvent } from 'react';
import { X, Pin, PinOff } from 'lucide-react';

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
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);
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

  const handlePinToggle = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const size = Math.max(rect.width, rect.height);

    const newRipple = {
      id: Date.now(),
      x: centerX,
      y: centerY,
      size: size,
    };

    setRipples([newRipple]);
    setTimeout(() => setRipples([]), 600);

    setPinned(!pinned);
  };

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
      // Find current line index
      const currentIndex = parsedLyrics.findIndex((line, idx) => {
        const nextLine = parsedLyrics[idx + 1];
        return currentPosition >= line.timestamp && (!nextLine || currentPosition < nextLine.timestamp);
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
            const isActive = currentPosition >= line.timestamp && (!nextLine || currentPosition < nextLine.timestamp);
            
            return (
              <div
                key={actualIdx}
                className={`text-center leading-tight text-[15px] ${
                  isActive ? 'lyric-line-active' : 'lyric-line-inactive'
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
        className="w-screen h-screen flex flex-col"
        style={{ background: 'rgba(0,0,0,0.85)', userSelect: 'none' } as never}
      >
      {/* Header with controls */}
      <div 
        className="flex items-center justify-between px-3 py-1.5 border-b border-white/10"
        style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
      >
        <div className="text-white/60 text-sm font-medium">Lyrics</div>
        <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as never}>
          {/* Pin button */}
          <button
            onClick={handlePinToggle}
            className="relative w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-colors flex items-center justify-center overflow-hidden"
          >
            {pinned ? (
              <Pin size={14} className="text-white" />
            ) : (
              <PinOff size={14} className="text-white/80" />
            )}
            {ripples.map((ripple) => (
              <span
                key={ripple.id}
                className="absolute rounded-full bg-white/30 animate-ripple"
                style={{
                  width: ripple.size * 2,
                  height: ripple.size * 2,
                  left: ripple.x - ripple.size,
                  top: ripple.y - ripple.size,
                }}
              />
            ))}
          </button>
          
          {/* Close button */}
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-red-500/80 transition-colors flex items-center justify-center"
          >
            <X size={14} className="text-white" />
          </button>
        </div>
      </div>

      {/* Lyrics content */}
      <div className="flex-1 overflow-hidden">
        {renderLyrics()}
      </div>
    </div>
    </>
  );
}
