import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';

const seg = (start, end, key, title, artist) => ({
  start, end, key, title, artist, album: null, links: { spotify: 'https://example.com/x' },
  probes: 2, matched: 2, confidence: 1,
});

const save = (store, segments, version = 'v1') =>
  store.saveResult({ videoId: 'vid00000001', durationSec: 200, pipelineVersion: version, coverage: [[0, 200]], segments, stats: { ok: true } });

test('save then read back a timeline in playback order', () => {
  const store = openStore(':memory:');
  save(store, [seg(60, 90, 'b::two', 'Two', 'B'), seg(10, 50, 'a::one', 'One', 'A'), seg(100, 120, null, null, null)]);

  const rows = store.getTimeline('vid00000001');
  assert.deepEqual(rows.map((r) => r.start), [10, 60, 100]);
  assert.deepEqual(rows.map((r) => r.title), ['One', 'Two', null]);
  assert.deepEqual(rows[0].links, { spotify: 'https://example.com/x' });
  assert.equal(store.getVideo('vid00000001').duration_sec, 200);
});

test('isFresh depends on status and pipeline version', () => {
  const store = openStore(':memory:');
  assert.equal(store.isFresh('vid00000001', 'v1'), false);
  save(store, []);
  assert.equal(store.isFresh('vid00000001', 'v1'), true);
  assert.equal(store.isFresh('vid00000001', 'v2'), false);
});

test('"no music" is cached: zero segments but still fresh', () => {
  const store = openStore(':memory:');
  save(store, []);
  assert.deepEqual(store.getTimeline('vid00000001'), []);
  assert.equal(store.isFresh('vid00000001', 'v1'), true);
});

test('re-saving replaces machine segments but keeps user-submitted ones', () => {
  const store = openStore(':memory:');
  save(store, [seg(10, 50, 'a::one', 'One', 'A')]);
  store.db
    .prepare("INSERT INTO segments (video_id, start_sec, end_sec, track_key, source, votes) VALUES (?, 55, 70, 'a::one', 'user', 3)")
    .run('vid00000001');

  save(store, [seg(10, 40, 'a::one', 'One', 'A'), seg(80, 99, 'c::three', 'Three', 'C')], 'v2');

  const rows = store.getTimeline('vid00000001');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.source), ['api', 'user', 'api']);
  assert.equal(rows[1].votes, 3);
});

test('a failed save rolls back completely', () => {
  const store = openStore(':memory:');
  save(store, [seg(10, 50, 'a::one', 'One', 'A')]);
  const bad = { ...seg(60, 70, 'b::two', 'Two', 'B'), start: undefined }; // NOT NULL violation
  assert.throws(() => save(store, [bad], 'v2'));
  assert.equal(store.getTimeline('vid00000001').length, 1);
  assert.equal(store.getVideo('vid00000001').pipeline_version, 'v1');
});
