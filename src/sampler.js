// Step 5 - SAMPLE
// Decide which short clips ("probes") inside each music region get sent for recognition.
// Recognition is the expensive step, so we probe sparsely instead of fingerprinting
// every second: one clip every `stepSec`, plus one near the end of long regions so a
// song change at the tail is not missed.

/**
 * @param {{start:number,end:number}[]} regions
 * @param {object} opts see config.sampler
 * @returns {{index:number, regionIndex:number, start:number, end:number}[]}
 */
export function planProbes(regions, opts = {}) {
  const {
    clipSec = 12,
    stepSec = 30,
    edgeMarginSec = 1,
    minClipSec = 5,
    tailCoverSec = 8,
  } = opts;

  const probes = [];
  regions.forEach((region, regionIndex) => {
    const len = region.end - region.start;
    if (len < minClipSec) return;

    // Short region: one clip covering (up to clipSec of) the whole thing.
    if (len < clipSec + 2 * edgeMarginSec) {
      probes.push({ regionIndex, start: region.start, end: Math.min(region.end, region.start + clipSec) });
      return;
    }

    const lo = region.start + edgeMarginSec;
    const hi = region.end - edgeMarginSec;
    let lastEnd = -Infinity;
    for (let s = lo; s + clipSec <= hi + 1e-9; s += stepSec) {
      probes.push({ regionIndex, start: s, end: s + clipSec });
      lastEnd = s + clipSec;
    }
    if (hi - lastEnd > tailCoverSec) {
      probes.push({ regionIndex, start: hi - clipSec, end: hi });
    }
  });

  return probes.map((p, index) => ({ ...p, index }));
}
