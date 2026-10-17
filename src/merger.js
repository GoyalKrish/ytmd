// Step 7 - MERGE
// Probes give us scattered answers ("at 0:20 it is song A, at 0:50 song A, at 1:20 song B").
// Turn that into a timeline of contiguous segments. Pure function, no I/O.
//
// Rules:
//  1. A missed probe sandwiched between two hits of the same song is treated as that song.
//  2. Consecutive probes with the same answer form one segment.
//  3. A boundary between two different answers is placed halfway between the last probe of
//     the first and the first probe of the next (the true change is somewhere in that gap).
//  4. The same song reappearing within `sameTrackGapSec` (music ducked under speech, a region
//     split by a sound effect) is joined into one segment.
//  5. Music we could not identify stays in the timeline as an "unidentified" segment (key null).

/**
 * @param {{regions:{start:number,end:number}[], probes:object[], results:(object|null)[]}} input
 *        results[i] is the recognizer output for probes[i] (null = no match)
 * @param {{sameTrackGapSec?:number}} opts
 * @returns {{start,end,key,title,artist,album,links,probes,matched,confidence}[]}
 */
export function buildSegments({ regions, probes, results }, opts = {}) {
  const { sameTrackGapSec = 20 } = opts;

  const byRegion = new Map();
  probes.forEach((p, i) => {
    const item = { ...p, track: results[i] ?? null, direct: results[i] != null };
    if (!byRegion.has(p.regionIndex)) byRegion.set(p.regionIndex, []);
    byRegion.get(p.regionIndex).push(item);
  });

  const raw = [];
  regions.forEach((region, ri) => {
    const list = (byRegion.get(ri) ?? []).sort((a, b) => a.start - b.start);
    if (list.length === 0) return; // region was too short to probe

    // Rule 1: bridge isolated misses.
    for (let i = 1; i < list.length - 1; i++) {
      const prev = list[i - 1].track;
      const next = list[i + 1].track;
      if (!list[i].track && prev && next && prev.key === next.key) {
        list[i] = { ...list[i], track: prev };
      }
    }

    // Rule 2: group consecutive identical answers.
    const groups = [];
    for (const item of list) {
      const key = item.track?.key ?? null;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(item);
      else groups.push({ key, track: item.track, items: [item] });
    }

    // Rule 3: boundaries.
    groups.forEach((g, gi) => {
      const first = g.items[0];
      const last = g.items[g.items.length - 1];
      const start = gi === 0 ? region.start : (groups[gi - 1].items.at(-1).end + first.start) / 2;
      const end = gi === groups.length - 1 ? region.end : (last.end + groups[gi + 1].items[0].start) / 2;
      raw.push({
        start,
        end,
        key: g.key,
        track: g.track,
        probes: g.items.length,
        matched: g.items.filter((i) => i.direct).length,
      });
    });
  });

  // Rule 4: join the same song across nearby regions.
  const joined = [];
  for (const seg of raw) {
    const prev = joined[joined.length - 1];
    if (prev && seg.key && prev.key === seg.key && seg.start - prev.end <= sameTrackGapSec) {
      prev.end = seg.end;
      prev.probes += seg.probes;
      prev.matched += seg.matched;
    } else {
      joined.push({ ...seg });
    }
  }

  return joined.map((s) => ({
    start: s.start,
    end: s.end,
    key: s.key,
    title: s.track?.title ?? null,
    artist: s.track?.artist ?? null,
    album: s.track?.album ?? null,
    links: s.track?.links ?? {},
    probes: s.probes,
    matched: s.matched,
    confidence: s.probes ? s.matched / s.probes : 0,
  }));
}
