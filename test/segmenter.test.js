import test from 'node:test';
import assert from 'node:assert/strict';
import { findMusicRegions, movingAverage } from '../src/segmenter.js';
import { framesFrom } from './helpers.js';

const between = (t, lo, hi) => (t >= lo && t <= hi ? 0.9 : 0.05);
const near = (actual, expected, tol = 2) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

test('movingAverage smooths and shrinks the window at the edges', () => {
  assert.deepEqual(movingAverage([0, 0, 3, 0, 0], 3), [0, 1, 1, 1, 0]);
  assert.deepEqual(movingAverage([1, 2, 3], 1), [1, 2, 3]);
});

test('one block of music becomes one region', () => {
  const frames = framesFrom(80, (t) => between(t, 20, 60));
  const regions = findMusicRegions(frames);
  assert.equal(regions.length, 1);
  near(regions[0].start, 20);
  near(regions[0].end, 60);
});

test('a short dip inside music does not split the region', () => {
  const frames = framesFrom(80, (t) => (t >= 10 && t <= 70 && !(t > 40 && t < 42) ? 0.9 : 0.05));
  const regions = findMusicRegions(frames);
  assert.equal(regions.length, 1);
  near(regions[0].start, 10);
  near(regions[0].end, 70);
});

test('a 3 second blip of music is discarded as too short', () => {
  const frames = framesFrom(60, (t) => between(t, 30, 33));
  assert.deepEqual(findMusicRegions(frames), []);
});

test('two songs separated by a long gap stay separate', () => {
  const frames = framesFrom(120, (t) => (between(t, 10, 40) > 0.5 || between(t, 60, 100) > 0.5 ? 0.9 : 0.05));
  assert.equal(findMusicRegions(frames).length, 2);
});

test('hysteresis: a middling score neither starts a region nor ends one', () => {
  const never = framesFrom(60, () => 0.4);
  assert.deepEqual(findMusicRegions(never), []);

  // loud for 10 s, then hovering at 0.4 (between the on/off thresholds) until 40 s
  const frames = framesFrom(60, (t) => (t < 10 ? 0.05 : t < 20 ? 0.9 : t < 40 ? 0.4 : 0.05));
  const regions = findMusicRegions(frames);
  assert.equal(regions.length, 1);
  assert.ok(regions[0].end > 38, `region should run through the 0.4 stretch, ended at ${regions[0].end}`);
});

test('region end is clamped to the audio duration', () => {
  const frames = framesFrom(50, (t) => between(t, 20, 50));
  const [r] = findMusicRegions(frames, { durationSec: 50 });
  assert.ok(r.end <= 50);
});

test('no frames -> no regions', () => {
  assert.deepEqual(findMusicRegions([]), []);
});
