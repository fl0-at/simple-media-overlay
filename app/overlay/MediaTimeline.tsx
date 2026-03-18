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
      data-no-drag
      style={{
        userSelect: 'none',
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      } as never}
      onClick={visible ? onProgressClick : undefined}
      aria-hidden={!visible}
    >
      <div
        className="h-full bg-white rounded-full origin-left"
        style={{
          transform: `scaleX(${Math.min(1, Math.max(0, progress))})`,
          transition: 'transform 33ms linear',
        }}
      />
    </div>
  );
}
