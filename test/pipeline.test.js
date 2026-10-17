// End-to-end: synthetic audio -> fake classifier -> real segmenter/sampler/merger/db,
// with a mock recognizer. Exercises orchestration, caching and tuning re-runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as baseConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { runPipeline } from '../src/pipeline.js';
import { MockRecognizer } from '../src/recognizer.js';
import { encodeWav } from '../src/audio.js';
import { SR, synth, fakeClassifier } from './helpers.js';

const near = (actual, expected, tol = 2) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

async function setup(parts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsd-'));
  const wavPath = path.join(dir, 'video.wav');
  await writeFile(wavPath, encodeWav(synth(parts), SR));

  const counts = { classifier: 0, recognizerFactory: 0 };
  const recognizer = new MockRecognizer(({ start }) =>
    start < 60 ? { artist: 'Artist A', title: 'Song A' }
      : start < 105 ? { artist: 'Artist B', title: 'Song B' }
        : { artist: 'Artist C', title: 'Song C' },
  );
  const store = openStore(':memory:');
  const deps = {
    config: { ...baseConfig, cacheDir: path.join(dir, 'cache'), pipelineVersion: 'test' },
    store,
    fetchAudio: async () => wavPath,
    getClassifier: async () => { counts.classifier++; return fakeClassifier; },
    getRecognizer: async () => { counts.recognizerFactory++; return recognizer; },
  };
  return { wavPath, counts, recognizer, store, deps };
}

const PARTS = [
  { sec: 20, kind: 'speech' },
  { sec: 80, kind: 'music' }, // 20-100 s: song A then song B
  { sec: 20, kind: 'speech' },
  { sec: 30, kind: 'music' }, // 120-150 s: song C
  { sec: 10, kind: 'speech' },
];

test('finds the three songs, with times close to where they really are', async () => {
  const { wavPath, deps, recognizer, store } = await setup(PARTS);
  const result = await runPipeline(wavPath, deps);

  assert.equal(result.cached, false);
  assert.deepEqual(result.segments.map((s) => s.title), ['Song A', 'Song B', 'Song C']);
  near(result.segments[0].start, 20);
  near(result.segments[1].end, 100);
  near(result.segments[2].start, 120);
  near(result.segments[2].end, 150);
  // the A -> B change happened at 60 s; probes only bound it to somewhere in 62-80 s
  assert.ok(result.segments[0].end >= 62 && result.segments[0].end <= 81, `boundary ${result.segments[0].end}`);

  assert.equal(result.stats.probes, 5);
  assert.equal(result.stats.apiCalls, 5);
  assert.equal(recognizer.calls, 5);
  near(result.stats.musicSec, 110, 4);

  // what was stored is what is returned
  const stored = store.getTimeline(result.videoId);
  assert.deepEqual(stored.map((s) => [s.start, s.end, s.title]), result.segments.map((s) => [s.start, s.end, s.title]));
});

test('second run is served from the DB with no model and no API calls', async () => {
  const { wavPath, deps, recognizer, counts } = await setup(PARTS);
  await runPipeline(wavPath, deps);
  const again = await runPipeline(wavPath, deps);

  assert.equal(again.cached, true);
  assert.equal(again.segments.length, 3);
  assert.equal(recognizer.calls, 5);
  assert.equal(counts.classifier, 1);
});

test('--force re-segments from cached frames and cached probe answers (no model, no API)', async () => {
  const { wavPath, deps, recognizer, counts } = await setup(PARTS);
  await runPipeline(wavPath, deps);
  const forced = await runPipeline(wavPath, { ...deps, force: true });

  assert.equal(forced.cached, false);
  assert.equal(forced.stats.apiCalls, 0);
  assert.equal(forced.stats.cachedProbes, 5);
  assert.equal(recognizer.calls, 5);
  assert.equal(counts.classifier, 1);
  assert.deepEqual(forced.segments.map((s) => s.title), ['Song A', 'Song B', 'Song C']);
});

test('--fresh recomputes everything', async () => {
  const { wavPath, deps, recognizer, counts } = await setup(PARTS);
  await runPipeline(wavPath, deps);
  await runPipeline(wavPath, { ...deps, fresh: true });

  assert.equal(counts.classifier, 2);
  assert.equal(recognizer.calls, 10);
});

test('a video with no music is stored as "done" and never touches the recognizer', async () => {
  const { wavPath, deps, counts, store } = await setup([{ sec: 40, kind: 'speech' }]);
  const result = await runPipeline(wavPath, deps);

  assert.deepEqual(result.segments, []);
  assert.equal(result.stats.probes, 0);
  assert.equal(counts.recognizerFactory, 0);
  assert.equal(store.isFresh(result.videoId, 'test'), true);

  const again = await runPipeline(wavPath, deps);
  assert.equal(again.cached, true);
  assert.equal(counts.classifier, 1);
});

test('a recognizer failure stops the run and leaves nothing half-saved', async () => {
  const { wavPath, deps, store } = await setup(PARTS);
  let n = 0;
  const flaky = new MockRecognizer(() => {
    if (++n === 3) throw new Error('quota exceeded');
    return { artist: 'Artist A', title: 'Song A' };
  });
  await assert.rejects(() => runPipeline(wavPath, { ...deps, getRecognizer: async () => flaky }), /quota exceeded/);
  assert.equal(store.isFresh('x', 'test'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM videos').get().n, 0);

  // the two paid-for answers are cached, so the retry only needs the remaining calls
  const ok = new MockRecognizer(() => ({ artist: 'Artist A', title: 'Song A' }));
  const retry = await runPipeline(wavPath, { ...deps, getRecognizer: async () => ok });
  assert.equal(retry.stats.cachedProbes, 2);
  assert.equal(ok.calls, 3);
});
