// The orchestrator: runs every step in order. All the heavy / external pieces are
// injected so tests (and, later, the extension backend) can swap them out.
//
//   fetch -> decode -> classify -> segment -> sample -> recognize -> merge -> store
//
// Caches (so tuning does not cost API credits or model time):
//   <cacheDir>/<id>.wav          downloaded audio
//   <cacheDir>/<id>.frames.json  YAMNet scores      (skips the model on re-runs)
//   <cacheDir>/<id>.probes.json  recognizer answers (skips paid API calls on re-runs)
//   DB row                       final result       (skips everything)

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveInput, fetchAudio as defaultFetchAudio } from './fetcher.js';
import { readWav, sliceSamples, encodeWav } from './audio.js';
import { findMusicRegions } from './segmenter.js';
import { planProbes } from './sampler.js';
import { buildSegments } from './merger.js';
import { formatTime } from './report.js';

const r1 = (x) => Math.round(x * 10) / 10;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} input YouTube URL / id / path to a local media file
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('./db.js').SongStore} deps.store
 * @param {() => Promise<{classify:Function}>} deps.getClassifier   lazy: only called if needed
 * @param {() => Promise<{recognize:Function}>} deps.getRecognizer  lazy: only called if needed
 * @param {Function} [deps.fetchAudio]
 * @param {Function} [deps.log]
 * @param {boolean} [deps.force]  ignore the DB cache (re-uses frame/probe caches)
 * @param {boolean} [deps.fresh]  also drop frame/probe caches (full recompute)
 */
export async function runPipeline(input, deps) {
  const {
    config,
    store,
    getClassifier,
    getRecognizer,
    fetchAudio = defaultFetchAudio,
    log = () => {},
    fresh = false,
  } = deps;
  const force = deps.force || fresh;

  const timings = {};
  const timed = async (name, fn) => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };

  const source = await resolveInput(input);
  const { videoId } = source;

  // 0. Cache lookup - the cheapest possible path.
  if (!force && store.isFresh(videoId, config.pipelineVersion)) {
    log(`cache hit for ${videoId}: nothing to process`);
    const row = store.getVideo(videoId);
    return {
      videoId,
      cached: true,
      durationSec: row.duration_sec,
      segments: store.getTimeline(videoId),
      stats: row.stats_json ? JSON.parse(row.stats_json) : null,
    };
  }

  await mkdir(config.cacheDir, { recursive: true });
  const framesPath = path.join(config.cacheDir, `${videoId}.frames.json`);
  const probesPath = path.join(config.cacheDir, `${videoId}.probes.json`);
  if (fresh) await Promise.all([rm(framesPath, { force: true }), rm(probesPath, { force: true })]);

  // 1. Fetch
  const wavPath = await timed('fetch', () =>
    fetchAudio(source, { cacheDir: config.cacheDir, sampleRate: config.sampleRate, log }),
  );

  // 2. Decode
  const { samples, sampleRate } = await timed('decode', () => readWav(wavPath));
  const durationSec = samples.length / sampleRate;
  log(`audio: ${formatTime(durationSec)} @ ${sampleRate} Hz`);

  // 3. Classify (music / speech score per frame)
  const frames = await timed('classify', async () => {
    const cached = await readJson(framesPath);
    if (cached?.frames) {
      log('frame scores: loaded from cache');
      return cached.frames.map(([t, music, speech]) => ({ t, music, speech }));
    }
    const classifier = await getClassifier();
    let lastPct = -10;
    const out = await classifier.classify(samples, sampleRate, {
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          log(`classify ${pct}%`);
        }
      },
    });
    await writeFile(
      framesPath,
      JSON.stringify({ frames: out.map((f) => [f.t, +f.music.toFixed(4), +f.speech.toFixed(4)]) }),
    );
    return out;
  });

  // 4. Segment: keep music, discard the rest
  const regions = await timed('segment', async () =>
    findMusicRegions(frames, { ...config.segmenter, durationSec }),
  );
  const musicSec = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
  log(`music regions: ${regions.length} (${formatTime(musicSec)} of ${formatTime(durationSec)})`);

  // 5. Sample: choose which clips to fingerprint
  const probes = planProbes(regions, config.sampler);

  // 6. Recognize (disk-cached per clip so a crash or quota error does not waste paid calls)
  const probeCache = (await readJson(probesPath)) ?? {};
  const results = [];
  let apiCalls = 0;
  let cachedProbes = 0;
  let recognizer = null;
  await timed('recognize', async () => {
    for (const probe of probes) {
      const key = `${r1(probe.start)}-${r1(probe.end)}`;
      if (Object.hasOwn(probeCache, key)) {
        results.push(probeCache[key]);
        cachedProbes++;
        continue;
      }
      recognizer ??= await getRecognizer();
      const clip = encodeWav(sliceSamples(samples, sampleRate, probe.start, probe.end), sampleRate);
      const hit = (await recognizer.recognize(clip, probe)) ?? null;
      apiCalls++;
      probeCache[key] = hit;
      results.push(hit);
      await writeFile(probesPath, JSON.stringify(probeCache));
      log(`probe ${probe.index + 1}/${probes.length} @ ${formatTime(probe.start)}: ${hit ? `${hit.artist} - ${hit.title}` : 'no match'}`);
    }
  });

  // 7. Merge probe answers into a timeline
  const segments = buildSegments({ regions, probes, results }, config.merger).map((s) => ({
    ...s,
    start: r1(s.start),
    end: r1(s.end),
  }));

  const stats = {
    durationSec: r1(durationSec),
    musicSec: r1(musicSec),
    musicRatio: durationSec ? musicSec / durationSec : 0,
    regions: regions.length,
    probes: probes.length,
    apiCalls,
    cachedProbes,
    matchedProbes: results.filter(Boolean).length,
    segments: segments.length,
    identifiedSegments: segments.filter((s) => s.key).length,
    timings: { ...timings },
  };

  // 8. Store (a video with no music is stored too, so we never reprocess it)
  store.saveResult({
    videoId,
    durationSec,
    pipelineVersion: config.pipelineVersion,
    coverage: [[0, r1(durationSec)]],
    segments,
    stats,
  });

  return { videoId, cached: false, durationSec, regions, probes, segments, stats };
}
