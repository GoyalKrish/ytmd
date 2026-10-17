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

import { readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
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
  const isFreshCache = !force && store.isFresh(videoId, config.pipelineVersion);
  log('\n================================================================================');
  log('[CHECKPOINT 0/8] INPUT RESOLUTION & CACHE CHECK');
  log('================================================================================');
  log(`  Input:          ${input}`);
  log(`  Source Kind:    ${source.kind}`);
  log(`  Video ID:       ${videoId}${source.path ? ` (${source.path})` : ''}`);
  log(`  Cache Status:   ${isFreshCache ? 'HIT (serving saved results from database)' : 'MISS (running detection pipeline)'}`);

  if (isFreshCache) {
    const row = store.getVideo(videoId);
    const cachedSegments = store.getTimeline(videoId);
    log(`  Cached Duration: ${formatTime(row.duration_sec ?? 0)} (${row.duration_sec}s)`);
    log(`  Cached Segments: ${cachedSegments.length} segment(s)`);
    cachedSegments.forEach((s, i) => {
      const desc = s.key ? `"${s.artist ?? 'Unknown artist'} - ${s.title ?? 'Unknown title'}"` : '(music, not identified)';
      log(`    Segment #${i + 1}: [${formatTime(s.start)} - ${formatTime(s.end)}] ${desc}`);
    });
    return {
      videoId,
      cached: true,
      durationSec: row.duration_sec,
      segments: cachedSegments,
      stats: row.stats_json ? JSON.parse(row.stats_json) : null,
    };
  }

  await mkdir(config.cacheDir, { recursive: true });
  const framesPath = path.join(config.cacheDir, `${videoId}.frames.json`);
  const probesPath = path.join(config.cacheDir, `${videoId}.probes.json`);
  if (fresh) await Promise.all([rm(framesPath, { force: true }), rm(probesPath, { force: true })]);

  // 1. Fetch
  log('\n================================================================================');
  log('[CHECKPOINT 1/8] FETCH AUDIO');
  log('================================================================================');
  log(`  Target Source:  ${source.kind === 'youtube' ? `YouTube (https://www.youtube.com/watch?v=${videoId})` : `Local File (${source.path})`}`);
  log(`  Target Format:  ${config.sampleRate} Hz, mono, 16-bit PCM WAV`);
  const wavPath = await timed('fetch', () =>
    fetchAudio(source, { cacheDir: config.cacheDir, sampleRate: config.sampleRate, log }),
  );
  let wavSizeStr = 'unknown size';
  try {
    const st = await stat(wavPath);
    wavSizeStr = `${(st.size / (1024 * 1024)).toFixed(2)} MB (${st.size.toLocaleString()} bytes)`;
  } catch {}
  log(`  Result WAV:     ${wavPath}`);
  log(`  File Size:      ${wavSizeStr}`);
  log(`  Fetch Time:     ${timings.fetch} ms`);

  // 2. Decode
  log('\n================================================================================');
  log('[CHECKPOINT 2/8] DECODE AUDIO');
  log('================================================================================');
  const { samples, sampleRate } = await timed('decode', () => readWav(wavPath));
  const durationSec = samples.length / sampleRate;
  log(`  Sample Rate:    ${sampleRate} Hz (mono, 16-bit PCM)`);
  log(`  Total Samples:  ${samples.length.toLocaleString()}`);
  log(`  Audio Duration: ${formatTime(durationSec)} (${durationSec.toFixed(2)}s)`);
  log(`  Decode Time:    ${timings.decode} ms`);

  // 3. Classify (music / speech score per frame)
  log('\n================================================================================');
  log('[CHECKPOINT 3/8] CLASSIFY AUDIO (YAMNet AudioSet)');
  log('================================================================================');
  let cachedFramesUsed = false;
  const frames = await timed('classify', async () => {
    const cached = await readJson(framesPath);
    if (cached?.frames) {
      cachedFramesUsed = true;
      log(`  Frame Scores:   Loaded from cache (${framesPath})`);
      return cached.frames.map(([t, music, speech]) => ({ t, music, speech }));
    }
    log('  Frame Scores:   Running YAMNet model inference...');
    const classifier = await getClassifier();
    let lastPct = -10;
    const out = await classifier.classify(samples, sampleRate, {
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          log(`    Classification progress: ${pct}%`);
        }
      },
    });
    await writeFile(
      framesPath,
      JSON.stringify({ frames: out.map((f) => [f.t, +f.music.toFixed(4), +f.speech.toFixed(4)]) }),
    );
    return out;
  });

  let musicSum = 0;
  let speechSum = 0;
  let maxMusic = 0;
  let musicFrameCount = 0;
  for (const f of frames) {
    musicSum += f.music;
    speechSum += f.speech;
    if (f.music > maxMusic) maxMusic = f.music;
    if (f.music >= config.segmenter.onThreshold) musicFrameCount++;
  }
  const avgMusic = frames.length ? musicSum / frames.length : 0;
  const avgSpeech = frames.length ? speechSum / frames.length : 0;
  const activePct = frames.length ? ((musicFrameCount / frames.length) * 100).toFixed(1) : '0.0';
  log(`  Total Frames:   ${frames.length} (hop: 0.48s, window: 0.975s)`);
  log(`  Music Score:    Avg ${(avgMusic * 100).toFixed(1)}% | Peak ${(maxMusic * 100).toFixed(1)}%`);
  log(`  Speech Score:   Avg ${(avgSpeech * 100).toFixed(1)}%`);
  log(`  Active Frames:  ${musicFrameCount}/${frames.length} (${activePct}%) >= onThreshold (${config.segmenter.onThreshold})`);
  log(`  Classify Time:  ${timings.classify} ms${cachedFramesUsed ? ' (cached)' : ''}`);

  // 4. Segment: keep music, discard the rest
  log('\n================================================================================');
  log('[CHECKPOINT 4/8] SEGMENT MUSIC REGIONS');
  log('================================================================================');
  log(`  Parameters:     onThreshold=${config.segmenter.onThreshold}, offThreshold=${config.segmenter.offThreshold}, minRegionSec=${config.segmenter.minRegionSec}s, mergeGapSec=${config.segmenter.mergeGapSec}s`);
  const regions = await timed('segment', async () =>
    findMusicRegions(frames, { ...config.segmenter, durationSec }),
  );
  const musicSec = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
  const musicRatioPct = durationSec ? ((musicSec / durationSec) * 100).toFixed(1) : '0.0';
  log(`  Regions Found:  ${regions.length} region(s)`);
  log(`  Music Coverage: ${formatTime(musicSec)} of ${formatTime(durationSec)} (${musicRatioPct}%)`);
  if (regions.length > 0) {
    regions.forEach((r, i) => {
      log(`    Region #${i + 1}: [${formatTime(r.start)} - ${formatTime(r.end)}] (${(r.end - r.start).toFixed(1)}s, avg music score: ${(r.score * 100).toFixed(1)}%)`);
    });
  } else {
    log('    (No music regions detected meeting duration/score thresholds)');
  }
  log(`  Segment Time:   ${timings.segment} ms`);

  // 5. Sample: choose which clips to fingerprint
  log('\n================================================================================');
  log('[CHECKPOINT 5/8] SAMPLE PROBES');
  log('================================================================================');
  log(`  Parameters:     clipSec=${config.sampler.clipSec}s, stepSec=${config.sampler.stepSec}s, minClipSec=${config.sampler.minClipSec}s, tailCoverSec=${config.sampler.tailCoverSec}s`);
  const probes = planProbes(regions, config.sampler);
  log(`  Probes Planned: ${probes.length} clip(s)`);
  if (probes.length > 0) {
    probes.forEach((p) => {
      log(`    Probe #${p.index + 1}: Region #${p.regionIndex + 1} [${formatTime(p.start)} - ${formatTime(p.end)}] (${(p.end - p.start).toFixed(1)}s)`);
    });
  } else {
    log('    (No probes planned because no music regions were found)');
  }

  // 6. Recognize (disk-cached per clip so a crash or quota error does not waste paid calls)
  log('\n================================================================================');
  log('[CHECKPOINT 6/8] RECOGNIZE PROBES');
  log('================================================================================');
  log(`  Provider:       ${config.recognizer.provider}`);
  const probeCache = (await readJson(probesPath)) ?? {};
  const results = [];
  let apiCalls = 0;
  let cachedProbes = 0;
  let recognizer = null;
  await timed('recognize', async () => {
    for (const probe of probes) {
      const key = `${r1(probe.start)}-${r1(probe.end)}`;
      if (Object.hasOwn(probeCache, key)) {
        const hit = probeCache[key];
        results.push(hit);
        cachedProbes++;
        log(`    Probe #${probe.index + 1}/${probes.length} [${formatTime(probe.start)} - ${formatTime(probe.end)}]: [CACHE HIT] -> ${hit ? `"${hit.artist} - ${hit.title}"` : 'No match'}`);
        continue;
      }
      recognizer ??= await getRecognizer();
      const clip = encodeWav(sliceSamples(samples, sampleRate, probe.start, probe.end), sampleRate);
      const hit = (await recognizer.recognize(clip, probe)) ?? null;
      apiCalls++;
      probeCache[key] = hit;
      results.push(hit);
      await writeFile(probesPath, JSON.stringify(probeCache));
      log(`    Probe #${probe.index + 1}/${probes.length} [${formatTime(probe.start)} - ${formatTime(probe.end)}]: [API CALL] -> ${hit ? `"${hit.artist} - ${hit.title}"` : 'No match'}`);
    }
  });
  const matchedCount = results.filter(Boolean).length;
  log(`  Recognition:    ${matchedCount}/${probes.length} matched (${apiCalls} API call(s), ${cachedProbes} cached)`);
  log(`  Recognize Time: ${timings.recognize} ms`);

  // 7. Merge probe answers into a timeline
  log('\n================================================================================');
  log('[CHECKPOINT 7/8] MERGE SEGMENTS');
  log('================================================================================');
  log(`  Parameters:     sameTrackGapSec=${config.merger.sameTrackGapSec}s`);
  const segments = buildSegments({ regions, probes, results }, config.merger).map((s) => ({
    ...s,
    start: r1(s.start),
    end: r1(s.end),
  }));
  log(`  Segments Built: ${segments.length} segment(s)`);
  if (segments.length > 0) {
    segments.forEach((s, i) => {
      const label = s.key ? `"${s.artist ?? 'Unknown artist'} - ${s.title ?? 'Unknown title'}"` : '(music, not identified)';
      const probeDetails = s.probes != null ? `[${s.matched}/${s.probes} probes matched, ${(s.confidence * 100).toFixed(0)}% confidence]` : '';
      log(`    Segment #${i + 1}: [${formatTime(s.start)} - ${formatTime(s.end)}] ${label} ${probeDetails}`);
    });
  } else {
    log('    (No song segments constructed)');
  }

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
  log('\n================================================================================');
  log('[CHECKPOINT 8/8] STORE RESULTS');
  log('================================================================================');
  log(`  Database Path:  ${config.dbPath}`);
  store.saveResult({
    videoId,
    durationSec,
    pipelineVersion: config.pipelineVersion,
    coverage: [[0, r1(durationSec)]],
    segments,
    stats,
  });
  const uniqueTrackCount = new Set(segments.filter((s) => s.key).map((s) => s.key)).size;
  log(`  DB Status:      Saved video '${videoId}' (${segments.length} segment(s), ${uniqueTrackCount} track(s))`);

  return { videoId, cached: false, durationSec, regions, probes, segments, stats };
}
