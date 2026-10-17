// Tests AuddRecognizer's HTTP handling against a local fake server (no real network).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AuddRecognizer, createRecognizer, trackKey } from '../src/recognizer.js';
import { encodeWav } from '../src/audio.js';

const clip = encodeWav(new Float32Array(1600).fill(0.1), 16000);

/** Start a server that answers with each handler in turn (the last one repeats). */
async function fakeAudd(...responders) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
      const respond = responders[Math.min(seen.length - 1, responders.length - 1)];
      respond(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, seen, close: () => server.close() };
}

const json = (status, body) => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const make = (url) => new AuddRecognizer({ apiToken: 'TESTTOKEN', endpoint: url, minIntervalMs: 0, maxRetries: 2 });

test('sends the clip as multipart with the token and maps a match', async () => {
  const srv = await fakeAudd(json(200, {
    status: 'success',
    result: {
      artist: 'Daft Punk', title: 'Around the World', album: 'Homework', song_link: 'https://lis.tn/x',
      spotify: { external_urls: { spotify: 'https://open.spotify.com/track/1' } },
      apple_music: { url: 'https://music.apple.com/x' },
    },
  }));
  try {
    const hit = await make(srv.url).recognize(clip);
    assert.equal(srv.seen.length, 1);
    assert.match(srv.seen[0].headers['content-type'], /^multipart\/form-data/);
    const body = srv.seen[0].body.toString('latin1');
    assert.ok(body.includes('TESTTOKEN'));
    assert.ok(body.includes('RIFF'), 'wav bytes should be uploaded');

    assert.equal(hit.title, 'Around the World');
    assert.equal(hit.artist, 'Daft Punk');
    assert.equal(hit.key, 'daft punk::around the world');
    assert.equal(hit.links.spotify, 'https://open.spotify.com/track/1');
    assert.equal(hit.links.appleMusic, 'https://music.apple.com/x');
  } finally {
    srv.close();
  }
});

test('"no match" comes back as null', async () => {
  const srv = await fakeAudd(json(200, { status: 'success', result: null }));
  try {
    assert.equal(await make(srv.url).recognize(clip), null);
  } finally {
    srv.close();
  }
});

test('API errors (bad token / quota) fail immediately without retrying', async () => {
  const srv = await fakeAudd(json(200, { status: 'error', error: { error_code: 901, error_message: 'limit reached' } }));
  try {
    await assert.rejects(() => make(srv.url).recognize(clip), /901.*limit reached/);
    assert.equal(srv.seen.length, 1);
  } finally {
    srv.close();
  }
});

test('a 5xx response is retried and then succeeds', async () => {
  const srv = await fakeAudd(json(503, {}), json(200, { status: 'success', result: { artist: 'A', title: 'B' } }));
  try {
    const hit = await make(srv.url).recognize(clip);
    assert.equal(hit.title, 'B');
    assert.equal(srv.seen.length, 2);
  } finally {
    srv.close();
  }
});

test('gives up after maxRetries on persistent 5xx', async () => {
  const srv = await fakeAudd(json(500, {}));
  try {
    await assert.rejects(() => make(srv.url).recognize(clip), /HTTP 500/);
    assert.equal(srv.seen.length, 3); // first try + 2 retries
  } finally {
    srv.close();
  }
});

test('trackKey ignores case/punctuation but keeps non-Latin text', () => {
  assert.equal(trackKey('Daft Punk', 'Around the World!'), trackKey('daft punk', 'around  the world'));
  assert.ok(trackKey('Ado', 'うっせぇわ').includes('うっせぇわ'));
  assert.notEqual(trackKey('A', 'Song'), trackKey('B', 'Song'));
});

test('createRecognizer insists on a token for audd and rejects unknown providers', () => {
  assert.throws(() => createRecognizer({ provider: 'audd', auddToken: '' }), /AUDD_API_TOKEN/);
  assert.throws(() => createRecognizer({ provider: 'nope' }), /Unknown recognizer/);
  assert.equal(typeof createRecognizer({ provider: 'mock' }).recognize, 'function');
});
