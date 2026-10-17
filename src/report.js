// Human-readable output for the CLI.

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function formatTimeline(segments) {
  if (!segments.length) return 'No music detected.';
  return segments
    .map((s) => {
      const span = `${formatTime(s.start)} - ${formatTime(s.end)}`;
      const what = s.key ? `${s.artist ?? 'Unknown artist'} - ${s.title ?? 'Unknown title'}` : '(music, not identified)';
      const detail = s.probes != null ? `  [${s.matched}/${s.probes} probes matched]` : '';
      return `${span}  ${what}${detail}`;
    })
    .join('\n');
}

export function formatStats(stats) {
  if (!stats) return '';
  const t = stats.timings ?? {};
  const lines = [
    `video length      ${formatTime(stats.durationSec)}`,
    `music detected    ${formatTime(stats.musicSec)} (${(stats.musicRatio * 100).toFixed(0)}%) in ${stats.regions} region(s)`,
    `probes            ${stats.probes} planned, ${stats.apiCalls} API call(s), ${stats.cachedProbes} from cache`,
    `identified        ${stats.matchedProbes}/${stats.probes} probes, ${stats.identifiedSegments}/${stats.segments} segment(s)`,
  ];
  const timing = Object.entries(t).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ');
  if (timing) lines.push(`timings           ${timing}`);
  return lines.join('\n');
}
