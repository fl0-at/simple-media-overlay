'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type MediaProps = {
  title: string;
  artist: string;
  album_title?: string | null;
  album_image?: string | null; // base64 without data URL prefix
  _updateTimestamp?: number; // Internal timestamp to force re-renders
};

type MediaSnapshot = {
  props: MediaProps;
  is_playing: boolean;
  position_ms: number | null;
  duration_ms: number | null;
  is_shuffle: boolean | null;
  repeat_mode: 'None' | 'Track' | 'List' | null;
  source_app_id: string | null;
};

export function useMediaInfo() {
  const [media, setMedia] = useState<MediaProps | null>(null);

  useEffect(() => {
    let unlistenMediaUpdate: (() => void) | undefined;
    let unlistenMediaSnapshot: (() => void) | undefined;

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

      // Listen for media_update events from gsmtc listener
      try {
        unlistenMediaUpdate = await listen<MediaProps>('media_update', (event) => {
          setMedia({ ...event.payload, _updateTimestamp: Date.now() });
        });
      } catch (err) {
        console.error('Failed to listen for media_update', err);
      }

      // Listen for media_snapshot events from polling loop
      try {
        unlistenMediaSnapshot = await listen<MediaSnapshot>('media_snapshot', (event) => {
          setMedia({ ...event.payload.props, _updateTimestamp: Date.now() });
        });
      } catch (err) {
        console.error('Failed to listen for media_snapshot', err);
      }
    })();

    return () => {
      unlistenMediaUpdate?.();
      unlistenMediaSnapshot?.();
    };
  }, []);

  return media;
}
