// Step 8 - STORE
// SQLite (via Node's built-in node:sqlite, so no native dependency) holding RESULTS only:
// who played when. Fingerprints/audio are never stored.
//
// Tables mirror the design we discussed, so moving to Postgres later is mostly a driver swap:
//   videos   - one row per processed video (status, pipeline version, coverage)
//   tracks   - one row per distinct song
//   segments - "this song played from X to Y in this video"
//
// "No music found" is cached too (a 'done' video with zero segments), so it is never reprocessed.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS videos (
  video_id         TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  duration_sec     REAL,
  coverage_json    TEXT,
  stats_json       TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  track_key  TEXT PRIMARY KEY,
  title      TEXT,
  artist     TEXT,
  album      TEXT,
  links_json TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  start_sec  REAL NOT NULL,
  end_sec    REAL NOT NULL,
  track_key  TEXT REFERENCES tracks(track_key), -- NULL = music detected but not identified
  confidence REAL,
  source     TEXT NOT NULL DEFAULT 'api',        -- 'api' | 'user' (crowdsourcing later)
  votes      INTEGER NOT NULL DEFAULT 0,         -- crowd votes, unrelated to probe matches
  probes     INTEGER,
  matched    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_sec);
`;

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return new SongStore(db);
}

export class SongStore {
  constructor(db) {
    this.db = db;
  }

  getVideo(videoId) {
    return this.db.prepare('SELECT * FROM videos WHERE video_id = ?').get(videoId) ?? null;
  }

  /** True when the video was fully processed by this pipeline version. */
  isFresh(videoId, pipelineVersion) {
    const v = this.getVideo(videoId);
    return !!v && v.status === 'done' && v.pipeline_version === pipelineVersion;
  }

  saveResult({ videoId, durationSec, pipelineVersion, coverage, segments, stats }) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO videos (video_id, status, pipeline_version, duration_sec, coverage_json, stats_json, updated_at)
         VALUES (?, 'done', ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           status = 'done',
           pipeline_version = excluded.pipeline_version,
           duration_sec = excluded.duration_sec,
           coverage_json = excluded.coverage_json,
           stats_json = excluded.stats_json,
           updated_at = excluded.updated_at`,
      ).run(
        videoId,
        pipelineVersion,
        durationSec,
        JSON.stringify(coverage ?? []),
        JSON.stringify(stats ?? null),
        new Date().toISOString(),
      );

      // Replace only machine-generated rows; user-submitted ones survive a reprocess.
      db.prepare("DELETE FROM segments WHERE video_id = ? AND source = 'api'").run(videoId);

      const upsertTrack = db.prepare(
        `INSERT INTO tracks (track_key, title, artist, album, links_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(track_key) DO UPDATE SET
           title = excluded.title, artist = excluded.artist,
           album = excluded.album, links_json = excluded.links_json`,
      );
      const insertSegment = db.prepare(
        `INSERT INTO segments (video_id, start_sec, end_sec, track_key, confidence, source, votes, probes, matched)
         VALUES (?, ?, ?, ?, ?, 'api', 0, ?, ?)`,
      );

      for (const s of segments) {
        if (s.key) upsertTrack.run(s.key, s.title, s.artist, s.album, JSON.stringify(s.links ?? {}));
        insertSegment.run(videoId, s.start, s.end, s.key ?? null, s.confidence ?? null, s.probes ?? null, s.matched ?? null);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Everything the panel needs for one video, in playback order. */
  getTimeline(videoId) {
    const rows = this.db
      .prepare(
        `SELECT s.*, t.title, t.artist, t.album, t.links_json
           FROM segments s LEFT JOIN tracks t ON t.track_key = s.track_key
          WHERE s.video_id = ? ORDER BY s.start_sec`,
      )
      .all(videoId);
    return rows.map((r) => ({
      start: r.start_sec,
      end: r.end_sec,
      key: r.track_key,
      title: r.title,
      artist: r.artist,
      album: r.album,
      links: r.links_json ? JSON.parse(r.links_json) : {},
      probes: r.probes,
      matched: r.matched,
      confidence: r.confidence,
      source: r.source,
      votes: r.votes,
    }));
  }

  close() {
    this.db.close();
  }
}
