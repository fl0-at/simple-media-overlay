'use client';

import { Pin, PinOff } from 'lucide-react';
import { MouseEvent } from 'react';

interface PinButtonProps {
  pinned: boolean;
  onToggle: (e: MouseEvent<HTMLButtonElement>) => void;
}

export function PinButton({ pinned, onToggle }: PinButtonProps) {
  return (
    <div className="flex flex-col ml-2 justify-center w-full h-full text-sm">
      <button
        className={
          'px-2 py-2 rounded-full text-xs w-full h-full ' +
          (pinned
            ? 'bg-white hover:bg-white/80 text-black'
            : 'bg-white/10 hover:bg-white/20 text-white')
        }
        onClick={onToggle}
        style={{ WebkitAppRegion: 'no-drag' } as never}
      >
        {pinned ? <PinOff /> : <Pin />}
      </button>
    </div>
  );
}
