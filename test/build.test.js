'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, summary, assert, ROOT } = require('./lib');
const { build } = require('../tools/build');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stubbook-build-'));

function embeddedData(html) {
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'data block present');
  return JSON.parse(m[1]);
}

test('build replaces the placeholder with parseable data', () => {
  const out = path.join(scratch, 'a.html');
  const res = build({ outFile: out });
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(!html.includes('__DATA_JSON__'));
  const data = embeddedData(html);
  assert.equal(data.games.length, res.games);
  assert.ok(data.games.length >= 74);
  assert.ok(data.teams.mlb && data.venues.venues && data.venues.meta.activeVenues.nhl === 32);
  // Every "<" in the blob is <-escaped, so "</script>" can never appear.
  const raw = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!raw.includes('<'), 'raw data blob contains an unescaped "<"');
});

test('build is deterministic (two runs are byte-identical)', () => {
  const a = path.join(scratch, 'b1.html');
  const b = path.join(scratch, 'b2.html');
  build({ outFile: a });
  build({ outFile: b });
  assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
});

test('committed index.html is not stale (run `node tools/build.js` if this fails)', () => {
  const fresh = path.join(scratch, 'fresh.html');
  build({ outFile: fresh });
  assert.equal(
    fs.readFileSync(fresh, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
    'index.html differs from a fresh build of src/template.html + data/'
  );
});

summary('build.test.js');
