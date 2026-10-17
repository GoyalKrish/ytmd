import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments } from '../src/merger.js';
import { track } from './helpers.js';

const A = track('Artist A', 'Song A');
const B = track('Artist B', 'Song B');
const probe = (index, regionIndex, start, end = start + 12) => ({ index, regionIndex, start, end });

test('two songs in one region are split halfway between the last/first probe of each', () => {
  const segs = buildSegments({
    regions: [{ start: 20, end: 100 }],
    probes: [probe(0, 0, 21), probe(1, 0, 51), probe(2, 0, 81)],
    results: [A, A, B],
  });
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].start, segs[0].end, segs[0].title], [20, 72, 'Song A']); // (63 + 81) / 2
  assert.deepEqual([segs[1].start, segs[1].end, segs[1].title], [72, 100, 'Song B']);
  assert.deepEqual([segs[0].probes, segs[0].matched, segs[1].probes], [2, 2, 1]);
});

test('a missed probe between two hits of the same song is bridged', () => {
  const segs = buildSegments({
    regions: [{ start: 20, end: 100 }],
    probes: [probe(0, 0, 21), probe(1, 0, 51), probe(2, 0, 81)],
    results: [A, null, A],
  });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].title, 'Song A');
  assert.deepEqual([segs[0].probes, segs[0].matched], [3, 2]);
  assert.ok(Math.abs(segs[0].confidence - 2 / 3) < 1e-9);
});

test('a miss at the edge is kept as an unidentified segment, not bridged', () => {
  const segs = buildSegments({
    regions: [{ start: 20, end: 100 }],
    probes: [probe(0, 0, 21), probe(1, 0, 51), probe(2, 0, 81)],
    results: [A, A, null],
  });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].key, A.key);
  assert.equal(segs[1].key, null);
  assert.equal(segs[1].title, null);
  assert.equal(segs[1].confidence, 0);
});

test('the same song in nearby regions is joined into one segment', () => {
  const input = {
    regions: [{ start: 20, end: 60 }, { start: 70, end: 100 }],
    probes: [probe(0, 0, 21), probe(1, 1, 71)],
    results: [A, A],
  };
  const segs = buildSegments(input, { sameTrackGapSec: 20 });
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].start, segs[0].end, segs[0].probes], [20, 100, 2]);
});

test('the same song far apart stays as two segments', () => {
  const input = {
    regions: [{ start: 20, end: 60 }, { start: 100, end: 130 }],
    probes: [probe(0, 0, 21), probe(1, 1, 101)],
    results: [A, A],
  };
  assert.equal(buildSegments(input, { sameTrackGapSec: 20 }).length, 2);
});

test('different songs in adjacent regions are never joined', () => {
  const input = {
    regions: [{ start: 20, end: 60 }, { start: 62, end: 100 }],
    probes: [probe(0, 0, 21), probe(1, 1, 63)],
    results: [A, B],
  };
  assert.equal(buildSegments(input).length, 2);
});

test('music that was never identified still appears in the timeline', () => {
  const segs = buildSegments({
    regions: [{ start: 5, end: 40 }],
    probes: [probe(0, 0, 6)],
    results: [null],
  });
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].key, segs[0].confidence], [null, 0]);
});

test('no regions -> empty timeline', () => {
  assert.deepEqual(buildSegments({ regions: [], probes: [], results: [] }), []);
});
