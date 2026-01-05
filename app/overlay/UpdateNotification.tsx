'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

interface UpdateNotificationProps {
  onDismiss?: () => void;
}

export default function UpdateNotification({ onDismiss }: UpdateNotificationProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [version, setVersion] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    // Listen for update events from Rust backend
    const setupListeners = async () => {
      const unlistenAvailable = await listen<string>('update-available', ({ payload }) => {
        setVersion(payload);
        setUpdateAvailable(true);
      });

      const unlistenDownloaded = await listen<string>('update-downloaded', () => {
        setUpdateDownloaded(true);
      });

      const unlistenError = await listen<string>('update-error', ({ payload }) => {
        setError(payload);
      });

      return () => {
        unlistenAvailable();
        unlistenDownloaded();
        unlistenError();
      };
    };

    setupListeners();
  }, []);

  if (error) {
    return (
      <div className="fixed top-4 right-4 bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm max-w-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">Update Error</p>
            <p className="text-sm opacity-90">{error}</p>
          </div>
          <button
            onClick={() => {
              setError('');
              onDismiss?.();
            }}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (updateDownloaded) {
    return (
      <div className="fixed top-4 right-4 bg-green-500/90 text-white px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm max-w-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">Update Ready!</p>
            <p className="text-sm opacity-90">
              Version {version} will be installed when you restart the app.
            </p>
          </div>
          <button
            onClick={() => {
              setUpdateDownloaded(false);
              onDismiss?.();
            }}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (updateAvailable) {
    return (
      <div className="fixed top-4 right-4 bg-blue-500/90 text-white px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm max-w-sm animate-slide-in">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">Update Available</p>
            <p className="text-sm opacity-90">
              Downloading version {version}... It will install automatically on next launch.
            </p>
          </div>
          <button
            onClick={() => {
              setUpdateAvailable(false);
              onDismiss?.();
            }}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return null;
}
