// Step 6 - RECOGNIZE
// Send one clip to a recognition service and get back a track (or null for "no match").
// Every provider implements:  recognize(wavBuffer, probe) -> Promise<Track | null>
//   Track = { key, title, artist, album, links }
// so providers can be swapped without touching the rest of the pipeline.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stable id for "the same song" across providers/runs: lowercase, punctuation stripped. */
export function trackKey(artist, title) {
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return `${norm(artist)}::${norm(title)}`;
}

export class RecognizerError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'RecognizerError';
    this.retryable = retryable;
  }
}

/**
 * AudD (https://audd.io) - hosted fingerprinting API. Check their site for the current
 * free tier / pricing before running on many videos.
 */
export class AuddRecognizer {
  constructor({ apiToken, minIntervalMs = 1000, maxRetries = 2, endpoint = 'https://api.audd.io/' }) {
    this.apiToken = apiToken;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.endpoint = endpoint;
    this.lastCallAt = 0;
  }

  async recognize(wavBuffer) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Crude rate limit: keep a minimum gap between calls.
      const wait = this.lastCallAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();

      try {
        return await this.#callOnce(wavBuffer);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof RecognizerError ? err.retryable : true; // network errors
        if (!retryable || attempt === this.maxRetries) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async #callOnce(wavBuffer) {
    const form = new FormData();
    form.append('api_token', this.apiToken);
    form.append('return', 'apple_music,spotify');
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'clip.wav');

    const res = await fetch(this.endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new RecognizerError(`AudD HTTP ${res.status}`, { retryable: true });
    }

    const json = await res.json();
    if (json.status === 'error') {
      // Bad token, quota used up, etc. - retrying will not help.
      throw new RecognizerError(
        `AudD error ${json.error?.error_code}: ${json.error?.error_message}`,
        { retryable: false },
      );
    }
    const r = json.result;
    if (!r) return null;

    return {
      key: trackKey(r.artist, r.title),
      title: r.title ?? null,
      artist: r.artist ?? null,
      album: r.album ?? null,
      links: {
        audd: r.song_link ?? null,
        spotify: r.spotify?.external_urls?.spotify ?? null,
        appleMusic: r.apple_music?.url ?? null,
      },
    };
  }
}

/** Test / dry-run provider. `fn(probe)` returns a Track-like object or null. */
export class MockRecognizer {
  constructor(fn) {
    this.fn = fn;
    this.calls = 0;
  }

  async recognize(_wavBuffer, probe) {
    this.calls++;
    const hit = await this.fn(probe);
    if (!hit) return null;
    return {
      key: hit.key ?? trackKey(hit.artist, hit.title),
      title: hit.title ?? null,
      artist: hit.artist ?? null,
      album: hit.album ?? null,
      links: hit.links ?? {},
    };
  }
}

export function createRecognizer(cfg) {
  switch (cfg.provider) {
    case 'audd':
      if (!cfg.auddToken) {
        throw new Error('AUDD_API_TOKEN is not set. Get a token at https://audd.io, or run with --recognizer mock.');
      }
      return new AuddRecognizer({
        apiToken: cfg.auddToken,
        minIntervalMs: cfg.minIntervalMs,
        maxRetries: cfg.maxRetries,
      });
    case 'mock':
      return new MockRecognizer(() => ({ artist: 'Mock Artist', title: 'Mock Song' }));
    default:
      throw new Error(`Unknown recognizer provider: ${cfg.provider}`);
  }
}
