import test from 'node:test';
import assert from 'node:assert/strict';
import { planProbes } from '../src/sampler.js';

const opts = { clipSec: 12, stepSec: 30, edgeMarginSec: 1, minClipSec: 5, tailCoverSec: 8 };

test('long region gets a clip every stepSec, skipping the edges', () => {
  const probes = planProbes([{ start: 20, end: 101 }], opts);
  assert.deepEqual(probes.map((p) => [p.start, p.end]), [[21, 33], [51, 63], [81, 93]]);
});

test('an uncovered tail gets one extra clip aligned to the end', () => {
  const probes = planProbes([{ start: 120, end: 150 }], opts);
  assert.deepEqual(probes.map((p) => [p.start, p.end]), [[121, 133], [137, 149]]);
});

test('a short region gets a single clip covering it', () => {
  const probes = planProbes([{ start: 10, end: 18 }], opts);
  assert.deepEqual(probes.map((p) => [p.start, p.end]), [[10, 18]]);
});

test('a region shorter than minClipSec is skipped', () => {
  assert.deepEqual(planProbes([{ start: 10, end: 13 }], opts), []);
});

test('probes are numbered in order and remember their region', () => {
  const probes = planProbes([{ start: 0, end: 20 }, { start: 100, end: 120 }], opts);
  assert.deepEqual(probes.map((p) => p.index), probes.map((_, i) => i));
  assert.deepEqual([...new Set(probes.map((p) => p.regionIndex))], [0, 1]);
});

test('every clip stays inside its region', () => {
  const regions = [{ start: 3.3, end: 97.7 }, { start: 130, end: 141 }];
  for (const p of planProbes(regions, opts)) {
    const r = regions[p.regionIndex];
    assert.ok(p.start >= r.start - 1e-9 && p.end <= r.end + 1e-9);
  }
});
