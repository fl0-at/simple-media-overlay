'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type MediaProps = {
  title: string;
  artist: string;
  album_title?: string | null;
  album_image?: string | null; // base64 without data URL prefix
};


export function useMediaInfo() {
  const [media, setMedia] = useState<MediaProps | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await invoke('start_media_listener');
      } catch (err) {
        console.error('start_media_listener failed', err);
      }

      try {
        const current = await invoke<MediaProps | null>('get_current_media');
        if (current) setMedia(current);
      } catch (err) {
        console.error('get_current_media failed', err);
      }
    })();
  }, []);

  return media;
}
