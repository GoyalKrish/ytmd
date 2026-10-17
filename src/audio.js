// Step 2 - DECODE
// Minimal WAV reader/writer (16-bit PCM, mono). No dependencies.

import { readFile } from 'node:fs/promises';

/** Parse a WAV buffer into Float32 samples in [-1, 1]. */
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // Streamed WAVs may declare a bogus size; clamp to what is actually there.
      size = Math.min(size, buf.length - body);
      data = { start: body, size };
      break;
    }
    pos = body + size + (size & 1);
  }

  if (!fmt || !data) throw new Error('WAV is missing a fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`Unsupported WAV (format=${fmt.format}, bits=${fmt.bits}); expected 16-bit PCM`);
  }
  if (fmt.channels !== 1) throw new Error(`Expected mono audio, got ${fmt.channels} channels`);

  const n = Math.floor(data.size / 2);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(data.start + i * 2) / 32768;
  return { samples, sampleRate: fmt.sampleRate };
}

export async function readWav(file) {
  return decodeWav(await readFile(file));
}

/** View of samples between two times (seconds). No copy. */
export function sliceSamples(samples, sampleRate, startSec, endSec) {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  return samples.subarray(a, Math.max(a, b));
}

/** Encode Float32 mono samples as a 16-bit PCM WAV buffer. */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(x < 0 ? x * 32768 : x * 32767), 44 + i * 2);
  }
  return buf;
}
