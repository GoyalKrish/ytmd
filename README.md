# yt-song-detector (spike)

Finds which songs play in a YouTube video and when, as a timeline:

```
00:19 - 01:12  Artist A - Song A   [2/2 probes matched]
01:12 - 01:41  Artist B - Song B   [1/1 probes matched]
01:59 - 02:31  Artist C - Song C   [2/2 probes matched]
```

This is the **detection engine** for the "Now playing" pill + song discovery panel idea.
It runs as a Node CLI so you can measure accuracy and cost before building the extension UI.

## Pipeline

Cheap filters first, expensive work last. Each step is one file in `src/`.

| # | Step | File | What it does |
|---|------|------|--------------|
| 1 | Fetch | `fetcher.js` | URL / id / local file -> 16 kHz mono WAV (yt-dlp + ffmpeg) |
| 2 | Decode | `audio.js` | WAV <-> Float32 samples, clip slicing |
| 3 | Classify | `classifier.js` | YAMNet scores every 0.48 s frame for "Music" and "Speech" |
| 4 | Segment | `segmenter.js` | Smooth + hysteresis -> music regions; non-music is discarded |
| 5 | Sample | `sampler.js` | Pick short clips (probes) inside each music region |
| 6 | Recognize | `recognizer.js` | Send each clip to AudD (swappable provider interface) |
| 7 | Merge | `merger.js` | Probe answers -> contiguous song segments |
| 8 | Store | `db.js` | SQLite: `videos`, `tracks`, `segments` (results only, no fingerprints) |
| - | Orchestrate | `pipeline.js`, `index.js` | Runs the steps, caches, CLI |

Dialogue removal is intentionally skipped (see "Not built yet").

## Setup

Requirements: Node >= 22.13, `ffmpeg`, `yt-dlp` (`pip install -U yt-dlp`).

```bash
npm install
export AUDD_API_TOKEN=your_token     # https://audd.io - check their current free tier
```

## Run

```bash
node src/index.js "https://www.youtube.com/watch?v=VIDEO_ID"
node src/index.js ./some-local-video.mp4         # local files work too
node src/index.js <url> --recognizer mock        # full pipeline, no API calls
node src/index.js <url> --json out.json          # full result incl. regions and probes
```

| Flag | Meaning |
|------|---------|
| `--force` | Ignore the DB cache; reuse cached frame scores and probe answers |
| `--fresh` | Recompute everything (drops frame + probe caches too) |
| `--recognizer audd\|mock` | Provider |

## Caching (so experiments are cheap)

| Cache | Skips |
|-------|-------|
| DB row (`data/songs.db`) | everything; "no music" results are cached too |
| `cache/<id>.frames.json` | the YAMNet pass |
| `cache/<id>.probes.json` | paid API calls (written after every call, so a crash or quota error loses nothing) |
| `cache/<id>.wav` | the download |

Tuning loop: change a threshold, run with `--force`. Segmentation re-runs instantly; only clips at new positions cost API calls.

## Tuning knobs (`src/config.js`, or env vars)

| Env var | Default | Effect |
|---------|---------|--------|
| `MUSIC_ON` / `MUSIC_OFF` | 0.5 / 0.3 | Smoothed music score to start / end a region. Lower `MUSIC_ON` to catch quiet background music |
| `SMOOTH_FRAMES` | 5 | Moving-average width (~2.4 s) |
| `MIN_REGION_SEC` / `MERGE_GAP_SEC` | 6 / 4 | Drop short blips / bridge short dips |
| `CLIP_SEC` | 12 | Clip length sent to the recognizer |
| `PROBE_STEP_SEC` | 30 | Spacing between clips. Smaller = finer song-change boundaries, more API calls |
| `SAME_TRACK_GAP_SEC` | 20 | Same song seen again within this gap becomes one segment |

## Tests

```bash
npm test
```

Covers audio I/O, URL parsing, segmentation, probe planning, merging, the DB, the AudD client (against a local fake server), the classifier's chunking, and the whole pipeline (synthetic audio, fake classifier, mock recognizer).

## Verify these first (not checked when this was written)

1. **YAMNet loading.** `classifier.js` loads the TF.js YAMNet model from TF Hub (`YAMNET_URL`). TF Hub has been moving to Kaggle; if the load fails, download the TF.js model files and point `YAMNET_DIR` at the folder containing `model.json`.
2. **Class indices.** Music = 137 and Speech = 0 are hardcoded defaults taken from memory. Download `yamnet_class_map.csv` (tensorflow/models -> research/audioset/yamnet) and set `YAMNET_CLASS_MAP` so they are looked up by name. If the first real run shows music scores near zero on obvious music, this is the first suspect.
3. **Speed.** Without `@tensorflow/tfjs-node` the model runs on the pure-JS CPU backend, which is slow on long videos. Try a 3-5 minute video first. `npm i @tensorflow/tfjs-node` is picked up automatically if it installs on your Node version.
4. **yt-dlp** download path, and the AudD response shape against a real token.

## Measuring for the case study

Every run prints (and `--json` saves) stats: music ratio, probes planned, API calls, probes matched, segments identified, per-step timings. For 10-15 varied videos (vlog, gaming, tutorial, trailer, with and without background music), write down the songs you hear by hand and compare. Record music-detection hits/misses, match rate, boundary error, API calls and seconds per video.

## From spike to extension

- **Moves into the extension unchanged:** `segmenter.js`, `sampler.js`, `merger.js`. The classifier logic is TF.js too; only model loading differs (WASM/WebGL backend, model bundled with the extension).
- **Gets replaced:** `fetcher.js` -> capture audio from the `<video>` element; `recognizer.js` -> call your own backend (keeps the API key off the client); `db.js` -> server DB with the same three tables.
- **Already shaped for crowdsourcing:** `segments.source` (`api` | `user`) and `segments.votes`. Reprocessing never deletes `user` rows.

## Known limits

- Song boundaries are only as precise as the probe spacing: the change is somewhere between the last probe of one song and the first of the next (the merger puts it halfway).
- Clips are sent at 16 kHz mono (what YAMNet needs). Recognition may improve with higher-quality clips.
- Background music under speech is the hard case; expect misses. Unidentified music is kept in the timeline as "(music, not identified)" so coverage is visible.
- `fetcher.js` downloads audio with yt-dlp for local experimentation only; do not ship that in a product.

## Not built yet

- Dialogue/vocal separation as a retry for probes that fail to match (planned fallback)
- Progressive coverage tracking (`videos.coverage_json` is stored but always the full range here)
- Crowdsourced submissions and votes
- Own fingerprint index
