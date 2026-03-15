/**
 * Utility functions for app identification and metadata.
 * Shared across overlay components.
 */

/**
 * Normalize a source app ID by:
 * 1. Converting to lowercase
 * 2. Extracting the segment before '!' (if present) - UWP app names are more useful before the '!'
 * 3. Removing trailing package/store identifiers after '_'
 * 
 * Examples:
 * - "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "microsoft.zunemusic"
 * - "VideoLAN.VLC_paz6r1rewnh0a!App" → "videolan.vlc"
 * - "com.spotify.music" → "com.spotify.music"
 * - "Chrome" → "chrome"
 */
export function normalizeAppId(sourceAppId: string | null | undefined): string {
  if (!sourceAppId) return '';
  const lower = sourceAppId.toLowerCase();
  // If there's a '!' then the segment before it often contains the app name; prefer that
  const beforeBang = lower.includes('!') ? lower.split('!')[0] : lower;
  // Remove any trailing store/package id after an underscore
  const beforeUnderscore = beforeBang.split('_')[0];
  return beforeUnderscore;
}

/**
 * Apps that don't support shuffle/repeat controls.
 * These will not show the 🔀 and 🔁 buttons.
 */
export const blockedAppsForPlaybackModes = [
    'tidal', 
    'chrome',
    'chromium',
    '308046b0af4a39cb', // Firefox
    'brave',
    'edge',
    'opera',
    'vivaldi',
    'safari',
    'mediamonkey',
    'foobar2000',
];

/**
 * Check if an app supports playback mode controls (shuffle/repeat).
 */
export function isPlaybackModeSupported(sourceAppId: string | null): boolean {
  if (!sourceAppId) return false;
  const normalized = normalizeAppId(sourceAppId);
  return !blockedAppsForPlaybackModes.some(app => normalized.includes(app));
}

/**
 * Player metadata: name and icon path.
 */
export interface PlayerInfo {
  name: string;
  imageSrc: string;
}

/**
 * Get player metadata based on normalized app ID.
 */
export function getPlayerInfo(sourceAppId: string | null): PlayerInfo {
  const id = normalizeAppId(sourceAppId);

  if (!id) return { name: 'Unknown App', imageSrc: '/Generic.svg' };

  // browsers
  if (id.includes('brave')) return { name: 'Brave Browser', imageSrc: '/Brave.png' };
  if (id.includes('chrome')) return { name: 'Chrome', imageSrc: '/Chrome.svg' };
  if (id.includes('chromium')) return { name: 'Chromium', imageSrc: '/Chromium.svg' };
  if (id.includes('edge')) return { name: 'Edge', imageSrc: '/Edge.svg' };
  if (id.includes('firefox') || id === '308046b0af4a39cb') return { name: 'Firefox', imageSrc: '/Firefox.svg' };
  if (id.includes('opera')) return { name: 'Opera', imageSrc: '/Opera.svg' };
  if (id.includes('vivaldi')) return { name: 'Vivaldi', imageSrc: '/Vivaldi.svg' };
  if (id.includes('safari')) return { name: 'Safari', imageSrc: '/Safari.svg' };
  
  // streaming services
  if (id.includes('spotify')) return { name: 'Spotify', imageSrc: '/Spotify.svg' };
  if (id.includes('tidal')) return { name: 'TIDAL', imageSrc: '/Tidal.png' };
  if (id.includes('applemusic') || id.includes('apple.music'))
    return { name: 'Apple Music', imageSrc: '/AppleMusic.svg' };
  if (id.includes('podcast') || id.includes('apple.podcasts'))
    return { name: 'Apple Podcasts', imageSrc: '/ApplePodcasts.svg' };
  
  // media players
  if (id.includes('itunes')) return { name: 'iTunes', imageSrc: '/iTunes.svg' };
  if (id.includes('foobar2000')) return { name: 'Foobar2000', imageSrc: '/Foobar2000.svg' };
  if (id.includes('groove')) return { name: 'Groove Music', imageSrc: '/Groove.svg' };
  if (id.includes('kmplayer')) return { name: 'KMPlayer', imageSrc: '/KMPlayer.png' };
  if (id.includes('mediamonkey')) return { name: 'MediaMonkey', imageSrc: '/MediaMonkey.png' };
  if (id.includes('mpc-hc64') || id.includes('mpc-hc') || id.includes('mpc-be') || id.includes('mpc') || id.includes('media.player.classic')) return { name: 'Media Player Classic', imageSrc: '/MPC.svg' };
  if (id.includes('videolan') || id.includes('vlc')) return { name: 'VLC', imageSrc: '/VLC.svg' };
  if (id.includes('winamp')) return { name: 'Winamp', imageSrc: '/Winamp.svg' };
  if (id.includes('zunemusic') || id.includes('windows.media') || id.includes('microsoft.zunemusic'))
    return { name: 'Windows Media Player', imageSrc: '/Win11_Media_Player.svg' };

  // other
  if (id.includes('kodi')) return { name: 'Kodi', imageSrc: '/Kodi.svg' };

  return { name: 'Unknown App', imageSrc: '/Generic.svg' };
}
