'use client';

import { MouseEvent } from 'react';

interface MediaTimelineProps {
  hasTimeline: boolean;
  progress: number;
  onProgressClick: (e: MouseEvent<HTMLDivElement>) => void;
}

export function MediaTimeline({ hasTimeline, progress, onProgressClick }: MediaTimelineProps) {
  const visible = Boolean(hasTimeline);

  return (
    <div
      className="mt-2 w-full h-1.5 bg-white/15 rounded-full cursor-pointer"
      style={{
        WebkitAppRegion: 'no-drag',
        userSelect: 'none',
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      } as never}
      onClick={visible ? onProgressClick : undefined}
      aria-hidden={!visible}
    >
      <div
        className="h-full bg-white rounded-full transition-all duration-75 ease-linear"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );
}
