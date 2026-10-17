#!/usr/bin/env node
// CLI entry point:  node src/index.js <youtube-url | video-id | local-file> [options]

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { openStore } from './db.js';
import { loadClassifier } from './classifier.js';
import { createRecognizer } from './recognizer.js';
import { runPipeline } from './pipeline.js';
import { formatTimeline, formatStats } from './report.js';

const USAGE = `Usage: node src/index.js <youtube-url | video-id | local-file> [options]

Options:
  --recognizer <audd|mock>  recognition provider (default: audd, needs AUDD_API_TOKEN)
  --force                   ignore the DB cache; reuse cached frame scores + probe answers
  --fresh                   recompute everything (also drops frame + probe caches)
  --json <file>             write the full result as JSON
  -h, --help                show this help

Env: AUDD_API_TOKEN, CACHE_DIR, DB_PATH, MUSIC_ON, MUSIC_OFF, PROBE_STEP_SEC, CLIP_SEC,
     YAMNET_URL, YAMNET_DIR, YAMNET_CLASS_MAP  (see src/config.js)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    recognizer: { type: 'string' },
    force: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

if (values.recognizer) config.recognizer.provider = values.recognizer;

const log = (msg) => console.error(`  ${msg}`);
const store = openStore(config.dbPath);

try {
  const result = await runPipeline(positionals[0], {
    config,
    store,
    log,
    force: values.force,
    fresh: values.fresh,
    getClassifier: () => loadClassifier(config.classifier, { log }),
    getRecognizer: async () => createRecognizer(config.recognizer),
  });

  console.log(`\nVideo: ${result.videoId}${result.cached ? '  (served from cache)' : ''}\n`);
  console.log(formatTimeline(result.segments));
  if (result.stats) console.log(`\n${formatStats(result.stats)}`);

  if (values.json) {
    await writeFile(values.json, JSON.stringify(result, null, 2));
    console.log(`\nWrote ${values.json}`);
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
