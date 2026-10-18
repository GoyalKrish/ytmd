// Step 6 - RECOGNIZE
// Send one clip to a recognition service and get back a track (or null for "no match").
// Every provider implements:  recognize(wavBuffer, probe) -> Promise<Track | null>
//   Track = { key, title, artist, album, links }
// so providers can be swapped without touching the rest of the pipeline.

import { createHmac } from 'node:crypto';

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

/**
 * ACRCloud (https://www.acrcloud.com) - Audio & Video Recognition project with the
 * "ACRCloud Music" bucket attached. Credentials come from the project page in their console.
 *
 * Request: multipart POST to https://<host>/v1/identify, signed with
 *   base64(HMAC-SHA1(secret, "POST\n/v1/identify\n<access_key>\naudio\n1\n<timestamp>"))
 */
export class AcrcloudRecognizer {
  constructor({ host, accessKey, accessSecret, endpoint, maxRetries = 2, minIntervalMs = 500 }) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
    this.endpoint = endpoint ?? `https://${host}/v1/identify`;
    this.maxRetries = maxRetries;
    this.minIntervalMs = minIntervalMs;
    this.lastCallAt = 0;
  }

  /** Exposed so it can be unit-tested against a known value. */
  sign(timestamp) {
    const toSign = ['POST', '/v1/identify', this.accessKey, 'audio', '1', timestamp].join('\n');
    return createHmac('sha1', this.accessSecret).update(toSign).digest('base64');
  }

  async recognize(wavBuffer) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
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
    const timestamp = String(Math.floor(Date.now() / 1000));
    const form = new FormData();
    form.append('access_key', this.accessKey);
    form.append('data_type', 'audio');
    form.append('signature_version', '1');
    form.append('signature', this.sign(timestamp));
    form.append('timestamp', timestamp);
    form.append('sample_bytes', String(wavBuffer.length));
    form.append('sample', new Blob([wavBuffer], { type: 'audio/wav' }), 'clip.wav');

    const res = await fetch(this.endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new RecognizerError(`ACRCloud HTTP ${res.status}`, { retryable: true });
    }

    const json = await res.json();
    const code = json.status?.code;
    if (code === 1001) return null; // "no result"
    if (code !== 0) {
      // Codes other than 0/1001 are not listed in the docs page I read. 2002 and 3000 are my
      // recollection of timeout / service errors; everything else (bad key, bad signature,
      // quota) is treated as permanent so a typo does not burn retries.
      throw new RecognizerError(`ACRCloud error ${code}: ${json.status?.msg}`, {
        retryable: code === 2002 || code === 3000,
      });
    }

    // Docs show both { metadata: { music: [...] } } and a bare { music: [...] }; entries
    // may be flat or wrapped in { result: {...} }. Accept all of them.
    const list = json.metadata?.music ?? json.music ?? [];
    if (list.length === 0) return null;
    const best = [...list].sort((a, b) => ((b.result ?? b).score ?? 0) - ((a.result ?? a).score ?? 0))[0];
    const r = best.result ?? best;

    const artist = (r.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || null;
    const ext = r.external_metadata ?? {};
    const ytId = ext.youtube?.vid ?? null;
    const spotifyId = ext.spotify?.track?.id ?? null;
    const deezerId = ext.deezer?.track?.id ?? null;

    return {
      key: trackKey(artist, r.title),
      title: r.title ?? null,
      artist,
      album: r.album?.name ?? null,
      score: r.score ?? null,
      playOffsetSec: r.play_offset_ms != null ? r.play_offset_ms / 1000 : null,
      links: {
        youtube: ytId ? `https://www.youtube.com/watch?v=${ytId}` : null,
        youtubeMusic: ytId ? `https://music.youtube.com/watch?v=${ytId}` : null,
        spotify: spotifyId ? `https://open.spotify.com/track/${spotifyId}` : null,
        deezer: deezerId ? `https://www.deezer.com/track/${deezerId}` : null,
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
    case 'acrcloud': {
      // Read from cfg.acrcloud if given, else straight from the environment.
      const env = process.env;
      const c = cfg.acrcloud ?? {};
      const host = c.host ?? env.ACR_HOST;
      const accessKey = c.accessKey ?? env.ACR_ACCESS_KEY;
      const accessSecret = c.accessSecret ?? env.ACR_ACCESS_SECRET;
      if (!host || !accessKey || !accessSecret) {
        throw new Error('Set ACR_HOST, ACR_ACCESS_KEY and ACR_ACCESS_SECRET (from your ACRCloud project page).');
      }
      return new AcrcloudRecognizer({
        host,
        accessKey,
        accessSecret,
        maxRetries: cfg.maxRetries,
        minIntervalMs: Math.min(cfg.minIntervalMs ?? 500, 500),
      });
    }
    case 'mock':
      return new MockRecognizer(() => ({ artist: 'Mock Artist', title: 'Mock Song' }));
    default:
      throw new Error(`Unknown recognizer provider: ${cfg.provider}`);
  }
}
