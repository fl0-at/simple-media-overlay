'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';

interface UpdateInfo {
  version: string;
  current_version: string;
}

interface UpdateNotificationProps {
  onDismiss?: () => void;
}

export default function UpdateNotification({ onDismiss }: UpdateNotificationProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string>('');
  const [justUpdated, setJustUpdated] = useState(false);
  const [previousVersion, setPreviousVersion] = useState<string>('');
  const [currentVersion, setCurrentVersion] = useState<string>('');

  useEffect(() => {
    // Check if app was just updated
    const checkIfUpdated = async () => {
      const version = await getVersion();
      setCurrentVersion(version);
      const lastVersion = localStorage.getItem('app-version');
      
      if (lastVersion && lastVersion !== version) {
        // App was updated!
        setPreviousVersion(lastVersion);
        setJustUpdated(true);
        
        // Auto-dismiss after 10 seconds
        setTimeout(() => {
          setJustUpdated(false);
        }, 10000);
      }
      
      // Store current version
      localStorage.setItem('app-version', version);
    };

    checkIfUpdated();

    // Listen for update events from Rust backend
    const setupListeners = async () => {
      const unlistenAvailable = await listen<UpdateInfo>('update-available', ({ payload }) => {
        setUpdateInfo(payload);
        setUpdateAvailable(true);
        setUpdateDownloaded(false);
      });

      const unlistenDownloaded = await listen<UpdateInfo>('update-downloaded', ({ payload }) => {
        setUpdateInfo(payload);
        setUpdateAvailable(false);
        setUpdateDownloaded(true);
      });

      const unlistenError = await listen<string>('update-error', ({ payload }) => {
        setError(payload);
        setUpdateAvailable(false);
        setUpdateDownloaded(false);
      });

      return () => {
        unlistenAvailable();
        unlistenDownloaded();
        unlistenError();
      };
    };

    setupListeners();
  }, []);

  if (justUpdated) {
    return (
      <div className="fixed top-4 right-4 bg-purple-500/90 text-white px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm max-w-sm animate-slide-in z-500">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">🎉 Successfully Updated!</p>
            <p className="text-sm opacity-90">
              Simple Media Overlay has been updated from v{previousVersion} to v{currentVersion}.
            </p>
          </div>
          <button
            onClick={() => {
              setJustUpdated(false);
              onDismiss?.();
            }}
            className="text-white/80 hover:text-white z-999"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed top-4 right-4 bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm max-w-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">❌ Update Error!</p>
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
            <p className="font-semibold">✅ Update Ready!</p>
            <p className="text-sm opacity-90">
              Version {updateInfo?.version} has been downloaded and will be installed automatically.
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
            <p className="font-semibold">⬇️ Downloading Update</p>
            <p className="text-sm opacity-90">
              Downloading version {updateInfo?.version} in the background... It will install automatically once downloaded and the app will restart.
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
