import { describe, expect, it } from 'vitest';
import { getLyricsErrorDisplay, getRetrySecondsRemaining } from './errors';

describe('getLyricsErrorDisplay', () => {
  it.each([
    ['not_found', false, 'No lyrics found'],
    ['invalid_request', false, "track's information"],
    ['access_denied', false, 'denied access'],
    ['rate_limited', true, 'Too many lyrics requests'],
    ['service_unavailable', true, 'temporarily unavailable'],
    ['timeout', true, 'timed out'],
    ['connection', true, 'Check your internet connection'],
    ['invalid_response', false, 'unreadable response'],
    ['unexpected', false, 'check for an app update'],
  ])('maps %s to a user-facing message and retry policy', (code, canRetry, message) => {
    const result = getLyricsErrorDisplay({ code });
    expect(result.message).toContain(message);
    expect(result.canRetry).toBe(canRetry);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it.each([500, 502, 503, 504])('shows HTTP %s instead of a generic fetch error', (status) => {
    expect(getLyricsErrorDisplay({ code: 'service_unavailable', status })).toEqual({
      message: `The lyrics service is temporarily unavailable (HTTP ${status}). Please try again later.`,
      canRetry: true,
      retryAfterSeconds: 0,
    });
  });

  it.each(['rate_limited', 'service_unavailable', 'timeout'])('honors retry delays for %s', (code) => {
    expect(getLyricsErrorDisplay({ code, retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
  });

  it('never enables retry for permanent errors even with a retry header', () => {
    expect(getLyricsErrorDisplay({ code: 'invalid_request', retryAfterSeconds: 30 })).toMatchObject({
      canRetry: false,
      retryAfterSeconds: 0,
    });
  });

  it.each([null, undefined, 'raw backend error', {}, { code: 'unknown' }, { code: 'toString' }])(
    'handles unrecognized errors safely without exposing raw details: %j',
    (error) => {
      expect(getLyricsErrorDisplay(error)).toEqual({
        message: 'Unable to load lyrics. Please check for an app update.',
        canRetry: false,
        retryAfterSeconds: 0,
      });
    },
  );

  it.each([-1, 1.5, Infinity, NaN, '30', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retry delays: %s',
    (retryAfterSeconds) => {
      expect(getLyricsErrorDisplay({ code: 'rate_limited', retryAfterSeconds }).retryAfterSeconds).toBe(0);
    },
  );
});

describe('getRetrySecondsRemaining', () => {
  it('keeps retry blocked until the full delay expires', () => {
    expect(getRetrySecondsRemaining(31_000, 1000)).toBe(30);
    expect(getRetrySecondsRemaining(31_000, 30_001)).toBe(1);
    expect(getRetrySecondsRemaining(31_000, 31_000)).toBe(0);
    expect(getRetrySecondsRemaining(31_000, 32_000)).toBe(0);
    expect(getRetrySecondsRemaining(0, 1000)).toBe(0);
  });
});
