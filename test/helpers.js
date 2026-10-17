// Shared test utilities: synthetic audio + a stand-in for YAMNet.

export const SR = 16000;

/**
 * Build audio from parts: 'music' = loud 440 Hz tone, 'speech' = quiet noise.
 * @param {{sec:number, kind:'music'|'speech'}[]} parts
 */
export function synth(parts, sr = SR) {
  const total = parts.reduce((sum, p) => sum + p.sec, 0);
  const out = new Float32Array(Math.round(total * sr));
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  let pos = 0;
  for (const p of parts) {
    const n = Math.round(p.sec * sr);
    for (let i = 0; i < n; i++) {
      out[pos + i] = p.kind === 'music' ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) : 0.04 * rand();
    }
    pos += n;
  }
  return out;
}

/** Same framing as YAMNet (0.975 s window / 0.48 s hop); "music" = loud frame. */
export const fakeClassifier = {
  async classify(samples) {
    const WIN = 15600;
    const HOP = 7680;
    const frames = [];
    for (let off = 0; off + WIN <= samples.length; off += HOP) {
      let sum = 0;
      for (let i = off; i < off + WIN; i++) sum += samples[i] * samples[i];
      const music = Math.sqrt(sum / WIN) > 0.2 ? 0.9 : 0.05;
      frames.push({ t: +(frames.length * 0.48).toFixed(3), music, speech: 1 - music });
    }
    return frames;
  },
};

/** Frames at 0.48 s spacing whose music score comes from scoreAt(t). */
export function framesFrom(durationSec, scoreAt) {
  const frames = [];
  for (let t = 0; t + 0.975 <= durationSec; t += 0.48) {
    const tt = +t.toFixed(3);
    frames.push({ t: tt, music: scoreAt(tt), speech: 0 });
  }
  return frames;
}

export const track = (artist, title) => ({
  key: `${artist.toLowerCase()}::${title.toLowerCase()}`,
  title,
  artist,
  album: null,
  links: {},
});
