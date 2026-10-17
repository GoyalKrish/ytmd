// Step 3 - CLASSIFY
// Run YAMNet (AudioSet classifier) over the whole waveform and keep, for every
// frame, how "Music" and "Speech"-like it is. Output is a list of
//   { t: startSecond, music: 0..1, speech: 0..1 }
// YAMNet scores one 0.975 s window every 0.48 s.
//
// This file uses TensorFlow.js, so the same logic can later run inside the
// extension (WASM/WebGL backend) with only the model-loading line changed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const SAMPLE_RATE = 16000;
export const FRAME_HOP_SEC = 0.48;
export const FRAME_WINDOW_SEC = 0.975;
const HOP = 7680; // 0.48 s * 16000
const WIN = 15600; // 0.975 s * 16000
const NUM_CLASSES = 521;

// Indices in YAMNet's yamnet_class_map.csv: Speech is 0 (/m/09x0r) and Music is 132 (/m/04rlf).
// (137 was Bass guitar).
export const DEFAULT_CLASSES = { Speech: 0, Music: 132 };

/** Read yamnet_class_map.csv ("index,mid,display_name") and find Music/Speech by name. */
export async function readClassMap(file) {
  const text = await readFile(file, 'utf8');
  const classes = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = line.match(/^(\d+),[^,]*,(.*)$/);
    if (!m) continue;
    const name = m[2].replace(/^"|"$/g, '');
    if (name === 'Music' || name === 'Speech') classes[name] = Number(m[1]);
  }
  if (classes.Music === undefined || classes.Speech === undefined) {
    throw new Error(`Could not find Music and Speech rows in ${file}`);
  }
  return classes;
}

/** IOHandler that loads a TF.js graph model from a local folder (model.json + shards). */
function fileHandler(dir) {
  return {
    async load() {
      const json = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8'));
      const manifest = json.weightsManifest ?? [];
      const weightSpecs = manifest.flatMap((group) => group.weights);
      const shards = [];
      for (const group of manifest) {
        for (const p of group.paths) shards.push(await readFile(path.join(dir, p)));
      }
      const all = Buffer.concat(shards);
      const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
      return {
        modelTopology: json.modelTopology,
        weightSpecs,
        weightData,
        format: json.format,
        generatedBy: json.generatedBy,
        convertedBy: json.convertedBy,
        signature: json.signature,
        userDefinedMetadata: json.userDefinedMetadata,
        modelInitializer: json.modelInitializer,
        initializerSignature: json.initializerSignature,
      };
    },
  };
}

async function loadTf(log) {
  // tfjs-node is much faster but optional (and not installable on every Node version).
  try {
    const m = await import('@tensorflow/tfjs-node');
    log('TensorFlow.js backend: tfjs-node (native)');
    return m.default ?? m;
  } catch {
    let m;
    try {
      m = await import('@tensorflow/tfjs');
    } catch {
      throw new Error('TensorFlow.js is not installed. Run `npm install` in the project folder first.');
    }
    const tf = m.default ?? m;
    await tf.setBackend('cpu');
    await tf.ready();
    log('TensorFlow.js backend: pure JS cpu (slow on long videos; npm i @tensorflow/tfjs-node to speed up)');
    return tf;
  }
}

/**
 * Wrap an already-loaded model. Split from loadClassifier so tests can inject a fake model.
 * @param {{tf:any, model:any, classes?:{Speech:number,Music:number}, chunkFrames?:number}} opts
 */
export function createClassifier({ tf, model, classes = DEFAULT_CLASSES, chunkFrames = 120 }) {
  async function scoreChunk(chunk) {
    const input = tf.tensor1d(chunk);
    let out;
    try {
      try {
        out = model.predict(input);
      } catch {
        out = await model.executeAsync(input); // graph has dynamic ops
      }
      const list = Array.isArray(out) ? out : [out];
      const scores = list.find((t) => t.shape.length === 2 && t.shape[1] === NUM_CLASSES);
      if (!scores) throw new Error('Model output has no [frames, 521] scores tensor');

      const data = await scores.data();
      const n = scores.shape[0];
      const music = new Float32Array(n);
      const speech = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        music[i] = data[i * NUM_CLASSES + classes.Music];
        speech[i] = data[i * NUM_CLASSES + classes.Speech];
      }
      return { music, speech };
    } finally {
      tf.dispose(input);
      if (out) tf.dispose(out);
    }
  }

  return {
    /**
     * @param {Float32Array} samples 16 kHz mono
     * @returns {Promise<{t:number, music:number, speech:number}[]>}
     */
    async classify(samples, sampleRate = SAMPLE_RATE, { onProgress } = {}) {
      if (sampleRate !== SAMPLE_RATE) throw new Error(`YAMNet needs ${SAMPLE_RATE} Hz audio, got ${sampleRate}`);

      // Chunks start on frame boundaries and overlap by exactly one window, so frame
      // k of chunk c is frame (c*chunkFrames + k) of the whole file - no gaps, no repeats.
      const step = chunkFrames * HOP;
      const chunkLen = WIN + (chunkFrames - 1) * HOP;
      const frames = [];

      for (let off = 0; off + WIN <= samples.length; off += step) {
        const chunk = samples.subarray(off, Math.min(off + chunkLen, samples.length));
        const { music, speech } = await scoreChunk(chunk);
        for (let i = 0; i < music.length; i++) {
          frames.push({
            t: +(frames.length * FRAME_HOP_SEC).toFixed(3),
            music: music[i],
            speech: speech[i],
          });
        }
        onProgress?.(Math.min(1, (off + step) / samples.length));
      }
      return frames;
    },
  };
}

/** Load YAMNet (from TF Hub, or a local folder via cfg.modelDir) and return a classifier. */
export async function loadClassifier(cfg, { log = () => {} } = {}) {
  const tf = await loadTf(log);
  let model;
  if (cfg.modelDir) {
    log(`loading YAMNet from ${cfg.modelDir}`);
    model = await tf.loadGraphModel(fileHandler(cfg.modelDir));
  } else {
    log(`loading YAMNet from ${cfg.modelUrl}`);
    model = await tf.loadGraphModel(cfg.modelUrl, { fromTFHub: true });
  }
  const classes = cfg.classMapPath ? await readClassMap(cfg.classMapPath) : DEFAULT_CLASSES;
  return createClassifier({ tf, model, classes, chunkFrames: cfg.chunkFrames });
}
