// Step 1 - FETCH
// Turn a YouTube URL / video id / local media file into a 16 kHz mono WAV on disk.
//
// NOTE: downloading YouTube audio with yt-dlp is for local experimentation only.
// The real extension will capture audio from the <video> element instead.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the 11-char video id from a URL (or accept a bare id). Returns null if invalid. */
export function parseVideoId(input) {
  const s = String(input).trim();
  if (ID_RE.test(s)) return s;

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/**
 * Work out what the user gave us.
 * @returns {{kind:'youtube', videoId:string} | {kind:'local', videoId:string, path:string}}
 */
export async function resolveInput(input) {
  if (existsSync(input)) {
    const abs = path.resolve(input);
    const st = await stat(abs);
    const hash = createHash('sha1')
      .update(`${abs}:${st.size}:${st.mtimeMs}`)
      .digest('hex')
      .slice(0, 10);
    return { kind: 'local', videoId: `local-${hash}`, path: abs };
  }
  const id = parseVideoId(input);
  if (!id) throw new Error(`Not a YouTube URL/ID or an existing file: ${input}`);
  return { kind: 'youtube', videoId: id };
}

async function ffmpegConvert(input, output, sampleRate) {
  try {
    await run('ffmpeg', [
      '-nostdin', '-y', '-v', 'error',
      '-i', input,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-c:a', 'pcm_s16le',
      output,
    ]);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('ffmpeg not found on PATH. Install ffmpeg first.');
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

async function ytdlpDownload(videoId, cacheDir) {
  const template = path.join(cacheDir, `${videoId}.src.%(ext)s`);
  try {
    await run(
      'yt-dlp',
      [
        '-f', 'bestaudio',
        '--no-playlist', '--no-progress',
        '-o', template,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('yt-dlp not found on PATH. Install it (pip install -U yt-dlp) and make sure ffmpeg is installed too.');
    }
    throw new Error(`yt-dlp failed: ${err.stderr || err.message}`);
  }
  const files = (await readdir(cacheDir)).filter(
    (f) => f.startsWith(`${videoId}.src.`) && !f.endsWith('.part'),
  );
  if (files.length === 0) throw new Error('yt-dlp finished but no audio file was found');
  return path.join(cacheDir, files[0]);
}

/**
 * Make sure `<cacheDir>/<videoId>.wav` exists (16 kHz, mono, 16-bit PCM) and return its path.
 */
export async function fetchAudio(source, { cacheDir, sampleRate = 16000, log = () => {} }) {
  await mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${source.videoId}.wav`);
  if (existsSync(out)) {
    log(`audio cache hit: ${out}`);
    return out;
  }

  if (source.kind === 'local') {
    log(`converting local file ${source.path}`);
    await ffmpegConvert(source.path, out, sampleRate);
  } else {
    log(`downloading audio for ${source.videoId} with yt-dlp`);
    const raw = await ytdlpDownload(source.videoId, cacheDir);
    await ffmpegConvert(raw, out, sampleRate);
    await rm(raw, { force: true });
  }
  return out;
}
