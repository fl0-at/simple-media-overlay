'use client';

import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Loader2 } from 'lucide-react';
import { isPlaybackModeSupported } from './appInfo';

type RepeatMode = 'none' | 'track' | 'list';

interface MediaControlsProps {
  isPlaying: boolean;
  isShuffle: boolean;
  repeatMode: RepeatMode;
  sourceAppId: string | null;
  playPauseImpact?: boolean;
  playbackLoading?: boolean;
  onControlPress?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPlayPause: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPrevious: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onNext: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onShuffle: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onRepeat: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function MediaControls({
  isPlaying,
  isShuffle,
  repeatMode,
  sourceAppId,
  playPauseImpact = false,
  playbackLoading = false,
  onControlPress,
  onPlayPause,
  onPrevious,
  onNext,
  onShuffle,
  onRepeat,
}: MediaControlsProps) {
  const showPlaybackModes = isPlaybackModeSupported(sourceAppId);

  const getRepeatIcon = () => {
    if (repeatMode === 'track') {
      return <Repeat1 />; // repeat once
    } else if (repeatMode === 'list') {
      return <Repeat />; // repeat all
    } else {
      return <Repeat />; // repeat off (same icon but different style)
    }
  };

  return (
    <div
      className="flex items-center gap-3 mt-3 justify-center"
      data-no-drag
      style={{
        userSelect: 'none',
      } as never}
    >
      {showPlaybackModes && (
        <button
          className={
            'px-2 py-1 rounded-full min-w-10 text-xs ' +
            (repeatMode !== 'none'
              ? 'bg-white text-black font-semibold'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          onMouseDown={onControlPress}
          onClick={onRepeat}
          id="repeat-button"
          data-no-drag
          title="Repeat Mode"
        >
          {getRepeatIcon()}
        </button>
      )}
      <button
        className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 min-w-10 text-xs"
        id="back-button"
        onMouseDown={onControlPress}
        onClick={onPrevious}
        data-no-drag
        title="Previous"
      >
        <SkipBack />
      </button>
      <button
        className={`px-3 py-1 rounded-full font-semibold min-w-10 ${playPauseImpact ? 'impact-animation' : ''} ${isPlaying ? 'bg-white text-xs text-black hover:bg-white/80' : 'bg-white/10 text-white hover:bg-white/20'}`}
        id="play-pause-button"
        onMouseDown={onControlPress}
        onClick={onPlayPause}
        data-no-drag
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {playbackLoading ? <Loader2 className="animate-spin" /> : isPlaying ? <Pause /> : <Play />}
      </button>
      <button
        className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 min-w-10 text-xs"
        id="next-button"
        onMouseDown={onControlPress}
        onClick={onNext}
        data-no-drag
        title="Next"
      >
        <SkipForward />
      </button>
      {showPlaybackModes && (
        <button
          className={
            'px-2 py-1 rounded-full min-w-10 text-xs ' +
            (isShuffle
              ? 'bg-white text-black font-semibold'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          onMouseDown={onControlPress}
          onClick={onShuffle}
          id="shuffle-button"
          data-no-drag
          title="Shuffle"
        >
          <Shuffle />
        </button>
      )}
    </div>
  );
}
