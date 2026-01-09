'use client';

import { Pin, PinOff, X } from 'lucide-react';
import { MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface WindowControlsProps {
  pinned: boolean;
  onPinToggle: (e: MouseEvent<HTMLButtonElement>) => void;
  onClose?: () => void | Promise<void>;
}

export function WindowControls({ pinned, onPinToggle, onClose }: WindowControlsProps) {
  const handleClose = async () => {
    if (onClose) {
      await onClose();
    } else {
      const window = getCurrentWindow();
      await window.close();
    }
  };

  return (
    <div className="flex gap-2">
      {/* Pin button */}
      <button
        onClick={onPinToggle}
        className={`relative w-8 h-8 rounded-full transition-colors flex items-center justify-center overflow-hidden ${
          pinned
            ? 'bg-white hover:bg-white/80 text-black'
            : 'bg-white/10 hover:bg-white/20 text-white'
        }`}
        title={pinned ? 'Unpin' : 'Pin'}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
      
      {/* Close button */}
      <button
        onClick={handleClose}
        className="w-8 h-8 rounded-full bg-white/10 hover:bg-red-500/80 transition-colors flex items-center justify-center text-white"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
