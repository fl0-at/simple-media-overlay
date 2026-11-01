import { describe, expect, it } from 'vitest';
import {
  getPlayerInfo,
  isPlaybackModeSupported,
  normalizeAppId,
} from './appInfo';

describe('normalizeAppId', () => {
  it('returns an empty ID for missing values', () => {
    expect(normalizeAppId(null)).toBe('');
    expect(normalizeAppId(undefined)).toBe('');
    expect(normalizeAppId('')).toBe('');
  });

  it('normalizes UWP app IDs', () => {
    expect(normalizeAppId('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'))
      .toBe('microsoft.zunemusic');
  });

  it('removes desktop and volatile MPRIS instance suffixes', () => {
    expect(normalizeAppId('com.spotify.music.desktop')).toBe('com.spotify.music');
    expect(normalizeAppId('Spotify.Instance12345.desktop')).toBe('spotify');
    expect(normalizeAppId('chromium.instance12345')).toBe('chromium');
  });
});

describe('isPlaybackModeSupported', () => {
  it('rejects missing IDs and players without playback mode controls', () => {
    expect(isPlaybackModeSupported(null)).toBe(false);
    expect(isPlaybackModeSupported('Google Chrome')).toBe(false);
    expect(isPlaybackModeSupported('com.spotify.music')).toBe(true);
  });

  it('checks blocked player IDs after normalization', () => {
    expect(isPlaybackModeSupported('TIDAL_123!TIDAL')).toBe(false);
    expect(isPlaybackModeSupported('308046b0af4a39cb')).toBe(false);
  });
});

describe('getPlayerInfo', () => {
  it('returns generic metadata for an unknown player', () => {
    expect(getPlayerInfo(null)).toEqual({
      name: 'Unknown App',
      imageSrc: '/Generic.svg',
    });
    expect(getPlayerInfo('unrecognized-player')).toEqual({
      name: 'Unknown App',
      imageSrc: '/Generic.svg',
    });
  });

  it('maps known player IDs to their display metadata', () => {
    expect(getPlayerInfo('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'))
      .toEqual({ name: 'Windows Media Player', imageSrc: '/Win11_Media_Player.svg' });
    expect(getPlayerInfo('com.spotify.music'))
      .toEqual({ name: 'Spotify', imageSrc: '/Spotify.svg' });
    expect(getPlayerInfo('org.videolan.VLC'))
      .toEqual({ name: 'VLC', imageSrc: '/VLC.svg' });
  });
});
