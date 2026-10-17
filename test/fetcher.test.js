import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseVideoId, resolveInput, fetchAudio } from '../src/fetcher.js';
import { encodeWav, readWav } from '../src/audio.js';
import { synth } from './helpers.js';

const ID = 'dQw4w9WgXcQ';

test('parseVideoId understands the common URL shapes', () => {
  assert.equal(parseVideoId(ID), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}&t=10s`), ID);
  assert.equal(parseVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`https://youtu.be/${ID}?si=abc`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/embed/${ID}`), ID);
});

test('parseVideoId rejects anything else', () => {
  assert.equal(parseVideoId(`https://example.com/watch?v=${ID}`), null);
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseVideoId('not a url'), null);
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}; rm -rf /`), null);
});

test('resolveInput treats an existing file as local and anything invalid as an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsd-'));
  const file = path.join(dir, 'a.wav');
  await writeFile(file, 'x');
  const local = await resolveInput(file);
  assert.equal(local.kind, 'local');
  assert.match(local.videoId, /^local-[0-9a-f]{10}$/);
  assert.equal((await resolveInput(ID)).kind, 'youtube');
  await assert.rejects(() => resolveInput('nope-not-a-video'), /Not a YouTube URL/);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('fetchAudio converts a local file to 16 kHz mono and then serves it from cache', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsd-'));
  const input = path.join(dir, 'in8k.wav');
  await writeFile(input, encodeWav(synth([{ sec: 2, kind: 'music' }], 8000), 8000));

  const source = await resolveInput(input);
  const logs = [];
  const out = await fetchAudio(source, { cacheDir: path.join(dir, 'cache'), sampleRate: 16000, log: (m) => logs.push(m) });
  const { samples, sampleRate } = await readWav(out);
  assert.equal(sampleRate, 16000);
  assert.ok(Math.abs(samples.length - 32000) < 200, `got ${samples.length} samples`);

  await fetchAudio(source, { cacheDir: path.join(dir, 'cache'), sampleRate: 16000, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => m.includes('cache hit')));
});
