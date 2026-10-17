// Tests the chunking / frame-alignment logic of classifier.js with a stand-in for
// TensorFlow.js and YAMNet. It does NOT exercise the real model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClassifier, readClassMap, DEFAULT_CLASSES } from '../src/classifier.js';
import { synth } from './helpers.js';

const WIN = 15600;
const HOP = 7680;
const NUM = 521;

const fakeTf = { tensor1d: (x) => ({ x }), dispose() {} };

function fakeModel(callLog = []) {
  return {
    predict(input) {
      const x = input.x;
      const frames = Math.floor((x.length - WIN) / HOP) + 1;
      callLog.push(x.length);
      const data = new Float32Array(frames * NUM);
      for (let k = 0; k < frames; k++) {
        let sum = 0;
        for (let i = k * HOP; i < k * HOP + WIN; i++) sum += x[i] * x[i];
        data[k * NUM + DEFAULT_CLASSES.Music] = Math.sqrt(sum / WIN);
      }
      return [
        { shape: [frames, NUM], data: async () => data }, // scores
        { shape: [frames, 1024], data: async () => new Float32Array(0) }, // embeddings (ignored)
      ];
    },
  };
}

const audio = synth([
  { sec: 10, kind: 'speech' },
  { sec: 10, kind: 'music' },
  { sec: 10, kind: 'speech' },
]);

test('chunked classification gives exactly the frames a single pass would', async () => {
  const calls = [];
  const chunked = createClassifier({ tf: fakeTf, model: fakeModel(calls), chunkFrames: 7 });
  const single = createClassifier({ tf: fakeTf, model: fakeModel(), chunkFrames: 100000 });

  const a = await chunked.classify(audio);
  const b = await single.classify(audio);

  assert.ok(calls.length > 5, 'expected several model calls');
  assert.equal(a.length, Math.floor((audio.length - WIN) / HOP) + 1);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].t, b[i].t);
    assert.ok(Math.abs(a[i].music - b[i].music) < 1e-6, `frame ${i} differs`);
  }
});

test('frame times advance by 0.48 s and the music block lands at 10-20 s', async () => {
  const clf = createClassifier({ tf: fakeTf, model: fakeModel(), chunkFrames: 11 });
  const frames = await clf.classify(audio);

  assert.equal(frames[0].t, 0);
  assert.equal(frames[1].t, 0.48);
  assert.equal(frames[50].t, 24);

  const loud = frames.filter((f) => f.music > 0.2);
  assert.ok(loud[0].t >= 9 && loud[0].t <= 10.5, `first loud frame at ${loud[0].t}`);
  assert.ok(loud.at(-1).t >= 18.5 && loud.at(-1).t <= 20, `last loud frame at ${loud.at(-1).t}`);
});

test('audio shorter than one window yields no frames; wrong sample rate is rejected', async () => {
  const clf = createClassifier({ tf: fakeTf, model: fakeModel(), chunkFrames: 7 });
  assert.deepEqual(await clf.classify(new Float32Array(1000)), []);
  await assert.rejects(() => clf.classify(audio, 44100), /16000/);
});

test('a model without a [frames, 521] output is rejected clearly', async () => {
  const bad = { predict: () => [{ shape: [3, 10], data: async () => new Float32Array(30) }] };
  const clf = createClassifier({ tf: fakeTf, model: bad, chunkFrames: 7 });
  await assert.rejects(() => clf.classify(audio), /521/);
});

test('readClassMap finds Music and Speech by name, even with quoted names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsd-'));
  const file = path.join(dir, 'map.csv');
  await writeFile(
    file,
    ['index,mid,display_name', '0,/m/09x0r,Speech', '1,/m/0ytgt,"Child speech, kid speaking"', '42,/m/04rlf,Music'].join('\n'),
  );
  assert.deepEqual(await readClassMap(file), { Speech: 0, Music: 42 });
});
