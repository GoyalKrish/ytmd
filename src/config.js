// Central place for every tunable. Env vars override defaults so you can
// experiment from the shell without editing code, e.g.
//   MUSIC_ON=0.4 PROBE_STEP_SEC=20 node src/index.js <url> --force

import { existsSync } from 'node:fs';

const env = process.env;
const num = (value, fallback) =>
  value === undefined || value === '' ? fallback : Number(value);

export const config = {
  // Bump this when the pipeline logic changes so old DB rows can be recomputed.
  pipelineVersion: '0.1.0',

  cacheDir: env.CACHE_DIR ?? './cache',
  dbPath: env.DB_PATH ?? './data/songs.db',

  // YAMNet needs 16 kHz mono. Everything downstream uses the same audio.
  sampleRate: 16000,

  classifier: {
    modelUrl: env.YAMNET_URL ?? 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1',
    // Optional: folder holding model.json + weight shards (offline / mirrored copy).
    modelDir: env.YAMNET_DIR ?? null,
    // Optional: yamnet_class_map.csv. When set, the Music/Speech class indices are
    // looked up by name instead of using the built-in defaults.
    classMapPath: env.YAMNET_CLASS_MAP ?? (existsSync('./data/yamnet_class_map.csv') ? './data/yamnet_class_map.csv' : null),
    // Frames scored per model call (120 frames ~= 58 s of audio).
    chunkFrames: 120,
  },

  segmenter: {
    smoothFrames: num(env.SMOOTH_FRAMES, 5), // moving average over ~2.4 s
    onThreshold: num(env.MUSIC_ON, 0.5), // smoothed score needed to start a region
    offThreshold: num(env.MUSIC_OFF, 0.3), // score below which a region ends
    minRegionSec: num(env.MIN_REGION_SEC, 6), // drop shorter blips
    mergeGapSec: num(env.MERGE_GAP_SEC, 4), // bridge short dips (e.g. a sound effect)
  },

  sampler: {
    clipSec: num(env.CLIP_SEC, 12), // length of each clip sent for recognition
    stepSec: num(env.PROBE_STEP_SEC, 30), // spacing between clip starts inside a region
    edgeMarginSec: 1, // skip fade in/out at region edges
    minClipSec: 5,
    tailCoverSec: 8, // add a clip near the end if more than this is uncovered
  },

  recognizer: {
    provider: env.RECOGNIZER ?? 'audd', // 'audd' | 'mock'
    auddToken: env.AUDD_API_TOKEN ?? '',
    minIntervalMs: num(env.API_MIN_INTERVAL_MS, 1000),
    maxRetries: 2,
  },

  merger: {
    // Same song seen again within this gap (e.g. music ducked under speech) => one segment.
    sameTrackGapSec: num(env.SAME_TRACK_GAP_SEC, 20),
  },
};
