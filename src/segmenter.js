// Step 4 - SEGMENT
// Turn noisy per-frame music scores into clean "music regions" and drop everything else.
// Pure functions, no I/O - this module can move into the extension unchanged.

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Centered moving average (window shrinks at the edges). */
export function movingAverage(values, window) {
  const half = Math.floor(window / 2);
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * @param {{t:number, music:number}[]} frames
 * @param {object} opts see config.segmenter (+ frameWindowSec, durationSec)
 * @returns {{start:number, end:number, score:number}[]} music regions in seconds
 */
export function findMusicRegions(frames, opts = {}) {
  const {
    smoothFrames = 5,
    onThreshold = 0.5,
    offThreshold = 0.3,
    minRegionSec = 6,
    mergeGapSec = 4,
    frameWindowSec = 0.975,
    durationSec = Infinity,
  } = opts;
  if (frames.length === 0) return [];

  const raw = frames.map((f) => f.music);
  const smooth = movingAverage(raw, smoothFrames);

  // Hysteresis: start above onThreshold, stop below offThreshold. Stops a region from
  // flickering on and off when the score hovers around a single cut-off.
  const spans = []; // [firstFrame, lastFrame]
  let open = -1;
  for (let i = 0; i < smooth.length; i++) {
    if (open < 0) {
      if (smooth[i] >= onThreshold) {
        // Walk back to where the score first rose above the "off" level.
        const floor = spans.length ? spans[spans.length - 1][1] + 1 : 0;
        let a = i;
        while (a > floor && smooth[a - 1] >= offThreshold) a--;
        open = a;
      }
    } else if (smooth[i] < offThreshold) {
      spans.push([open, i - 1]);
      open = -1;
    }
  }
  if (open >= 0) spans.push([open, smooth.length - 1]);

  // Bridge short dips, then drop regions that are too short to be a real song.
  const merged = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    const gap = prev ? frames[span[0]].t - (frames[prev[1]].t + frameWindowSec) : Infinity;
    if (prev && gap <= mergeGapSec) prev[1] = span[1];
    else merged.push([...span]);
  }

  return merged
    .map(([a, b]) => ({
      start: frames[a].t,
      end: Math.min(durationSec, frames[b].t + frameWindowSec),
      score: mean(raw.slice(a, b + 1)),
    }))
    .filter((r) => r.end - r.start >= minRegionSec);
}
