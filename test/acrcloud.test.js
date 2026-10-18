// AcrcloudRecognizer against a local fake server (no real network, no real credentials).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { AcrcloudRecognizer, createRecognizer } from '../src/recognizer.js';
import { encodeWav } from '../src/audio.js';

const clip = encodeWav(new Float32Array(1600).fill(0.1), 16000);
const KEY = 'KEY123';
const SECRET = 'SECRET456';

async function fakeServer(...responders) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
      responders[Math.min(seen.length - 1, responders.length - 1)](res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/identify`, seen, close: () => server.close() };
}

const json = (status, body) => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const make = (url, extra = {}) =>
  new AcrcloudRecognizer({ accessKey: KEY, accessSecret: SECRET, endpoint: url, minIntervalMs: 0, maxRetries: 2, ...extra });

/** Pull a multipart text field out of a raw body. */
const field = (body, name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

const entry = {
  title: 'Around the World',
  score: 92,
  play_offset_ms: 6440,
  album: { name: 'Homework' },
  artists: [{ name: 'Daft Punk' }],
  external_metadata: {
    youtube: { vid: 'dwDns8x3Jb4' },
    spotify: { track: { id: 'abc123' } },
    deezer: { track: { id: '777' } },
  },
};

test('signature matches an independently computed HMAC-SHA1 value', () => {
  // Reference value computed with Python's hmac/hashlib/base64 for the same string-to-sign.
  assert.equal(make('http://x/').sign('1700000000'), '+0eZ8a5scCL6exz/pjbpn4XxFFs=');
});

test('sends a correctly signed multipart request and maps a metadata.music match', async () => {
  const srv = await fakeServer(json(200, { status: { code: 0, msg: 'Success' }, metadata: { music: [entry] } }));
  try {
    const hit = await make(srv.url).recognize(clip);

    const req = srv.seen[0];
    assert.equal(req.method, 'POST');
    assert.match(req.headers['content-type'], /^multipart\/form-data/);
    assert.equal(field(req.body, 'access_key'), KEY);
    assert.equal(field(req.body, 'data_type'), 'audio');
    assert.equal(field(req.body, 'signature_version'), '1');
    assert.equal(field(req.body, 'sample_bytes'), String(clip.length));
    assert.ok(req.body.includes('RIFF'), 'wav bytes should be uploaded');

    // server-side check: recompute the signature from what was actually sent
    const ts = field(req.body, 'timestamp');
    assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 30);
    const expected = createHmac('sha1', SECRET)
      .update(['POST', '/v1/identify', KEY, 'audio', '1', ts].join('\n'))
      .digest('base64');
    assert.equal(field(req.body, 'signature'), expected);
    assert.ok(!req.body.includes(SECRET), 'secret must never be sent');

    assert.equal(hit.title, 'Around the World');
    assert.equal(hit.artist, 'Daft Punk');
    assert.equal(hit.album, 'Homework');
    assert.equal(hit.key, 'daft punk::around the world');
    assert.equal(hit.score, 92);
    assert.equal(hit.playOffsetSec, 6.44);
    assert.equal(hit.links.youtubeMusic, 'https://music.youtube.com/watch?v=dwDns8x3Jb4');
    assert.equal(hit.links.spotify, 'https://open.spotify.com/track/abc123');
  } finally {
    srv.close();
  }
});

test('also accepts a bare { music: [...] } body with entries wrapped in { result }', async () => {
  const srv = await fakeServer(json(200, { status: { code: 0 }, music: [{ offset: 0, result: entry }] }));
  try {
    assert.equal((await make(srv.url).recognize(clip)).title, 'Around the World');
  } finally {
    srv.close();
  }
});

test('picks the highest-scoring entry and joins multiple artists', async () => {
  const low = { ...entry, title: 'Low', score: 71 };
  const high = { ...entry, title: 'High', score: 99, artists: [{ name: 'A' }, { name: 'B' }] };
  const srv = await fakeServer(json(200, { status: { code: 0 }, metadata: { music: [low, high] } }));
  try {
    const hit = await make(srv.url).recognize(clip);
    assert.deepEqual([hit.title, hit.artist], ['High', 'A, B']);
  } finally {
    srv.close();
  }
});

test('missing optional metadata gives null links, not crashes', async () => {
  const bare = { title: 'T', score: 80, artists: [{ name: 'X' }] };
  const srv = await fakeServer(json(200, { status: { code: 0 }, metadata: { music: [bare] } }));
  try {
    const hit = await make(srv.url).recognize(clip);
    assert.equal(hit.album, null);
    assert.deepEqual(hit.links, { youtube: null, youtubeMusic: null, spotify: null, deezer: null });
  } finally {
    srv.close();
  }
});

test('status 1001 (no result) comes back as null without retrying', async () => {
  const srv = await fakeServer(json(200, { status: { code: 1001, msg: 'No result' } }));
  try {
    assert.equal(await make(srv.url).recognize(clip), null);
    assert.equal(srv.seen.length, 1);
  } finally {
    srv.close();
  }
});

test('auth / quota style errors fail immediately with the code in the message', async () => {
  const srv = await fakeServer(json(200, { status: { code: 3001, msg: 'invalid access key' } }));
  try {
    await assert.rejects(() => make(srv.url).recognize(clip), /3001.*invalid access key/);
    assert.equal(srv.seen.length, 1);
  } finally {
    srv.close();
  }
});

test('a 5xx is retried and then succeeds; persistent 5xx gives up after maxRetries', async () => {
  const ok = await fakeServer(json(503, {}), json(200, { status: { code: 0 }, metadata: { music: [entry] } }));
  try {
    assert.equal((await make(ok.url).recognize(clip)).title, 'Around the World');
    assert.equal(ok.seen.length, 2);
  } finally {
    ok.close();
  }

  const bad = await fakeServer(json(500, {}));
  try {
    await assert.rejects(() => make(bad.url).recognize(clip), /HTTP 500/);
    assert.equal(bad.seen.length, 3);
  } finally {
    bad.close();
  }
});

test('createRecognizer("acrcloud") needs all three env vars and builds from the host', () => {
  const saved = { h: process.env.ACR_HOST, k: process.env.ACR_ACCESS_KEY, s: process.env.ACR_ACCESS_SECRET };
  try {
    delete process.env.ACR_HOST;
    delete process.env.ACR_ACCESS_KEY;
    delete process.env.ACR_ACCESS_SECRET;
    assert.throws(() => createRecognizer({ provider: 'acrcloud' }), /ACR_HOST/);

    process.env.ACR_HOST = 'identify-ap-southeast-1.acrcloud.com';
    process.env.ACR_ACCESS_KEY = KEY;
    process.env.ACR_ACCESS_SECRET = SECRET;
    const r = createRecognizer({ provider: 'acrcloud', maxRetries: 2 });
    assert.equal(r.endpoint, 'https://identify-ap-southeast-1.acrcloud.com/v1/identify');
  } finally {
    for (const [name, v] of [['ACR_HOST', saved.h], ['ACR_ACCESS_KEY', saved.k], ['ACR_ACCESS_SECRET', saved.s]]) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }
});