import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav, sliceSamples } from '../src/audio.js';

test('encodeWav -> decodeWav round-trips samples', () => {
  const x = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.8);
  const { samples, sampleRate } = decodeWav(encodeWav(x, 16000));
  assert.equal(sampleRate, 16000);
  assert.equal(samples.length, x.length);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(samples[i] - x[i]) < 1e-3);
});

test('decodeWav skips extra chunks (LIST) before the data chunk', () => {
  const x = new Float32Array(100).fill(0.25);
  const wav = encodeWav(x, 16000);
  const list = Buffer.alloc(12);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(4, 4);
  list.write('abcd', 8, 'ascii');
  const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  const { samples } = decodeWav(withList);
  assert.equal(samples.length, 100);
  assert.ok(Math.abs(samples[0] - 0.25) < 1e-3);
});

test('decodeWav tolerates a data size larger than the file (streamed WAV)', () => {
  const wav = encodeWav(new Float32Array(50).fill(0.1), 16000);
  wav.writeUInt32LE(0xffffffff, 40);
  assert.equal(decodeWav(wav).samples.length, 50);
});

test('decodeWav rejects non-WAV input and stereo audio', () => {
  assert.throws(() => decodeWav(Buffer.from('definitely not a wav file')), /RIFF/);
  const wav = encodeWav(new Float32Array(10), 16000);
  wav.writeUInt16LE(2, 22); // pretend stereo
  assert.throws(() => decodeWav(wav), /mono/);
});

test('sliceSamples clamps to the buffer', () => {
  const x = new Float32Array(16000 * 10);
  assert.equal(sliceSamples(x, 16000, 2, 4).length, 32000);
  assert.equal(sliceSamples(x, 16000, 8, 99).length, 32000);
  assert.equal(sliceSamples(x, 16000, 50, 60).length, 0);
});
