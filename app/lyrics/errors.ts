export interface LyricsErrorDisplay {
  message: string;
  canRetry: boolean;
  retryAfterSeconds: number;
}

const messages = {
  not_found: { message: 'No lyrics found for this track.', canRetry: false },
  invalid_request: { message: "Lyrics could not be requested with this track's information. Try a different song.", canRetry: false },
  access_denied: { message: 'The lyrics service denied access. Please check for an app update.', canRetry: false },
  rate_limited: { message: 'Too many lyrics requests. Please wait before retrying.', canRetry: true },
  service_unavailable: { message: 'The lyrics service is temporarily unavailable. Please try again later.', canRetry: true },
  timeout: { message: 'The lyrics request timed out. Please try again.', canRetry: true },
  connection: { message: 'Could not connect to the lyrics service. Check your internet connection and try again.', canRetry: true },
  invalid_response: { message: 'The lyrics service returned an unreadable response. Please check for an app update.', canRetry: false },
  unexpected: { message: 'Unable to load lyrics. Please check for an app update.', canRetry: false },
} satisfies Record<string, { message: string; canRetry: boolean }>;

function isLyricsErrorCode(code: unknown): code is keyof typeof messages {
  return typeof code === 'string' && Object.hasOwn(messages, code);
}

export function getLyricsErrorDisplay(error: unknown): LyricsErrorDisplay {
  if (typeof error !== 'object' || error === null || !('code' in error)
    || !isLyricsErrorCode(error.code)) {
    return { ...messages.unexpected, retryAfterSeconds: 0 };
  }

  const display = messages[error.code];
  const status = 'status' in error && typeof error.status === 'number'
    && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
    ? error.status : null;
  const delay = 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
    && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0
    ? error.retryAfterSeconds : 0;

  return {
    ...display,
    message: error.code === 'service_unavailable' && status !== null
      ? `The lyrics service is temporarily unavailable (HTTP ${status}). Please try again later.`
      : display.message,
    retryAfterSeconds: display.canRetry ? delay : 0,
  };
}

export function getRetrySecondsRemaining(retryAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
