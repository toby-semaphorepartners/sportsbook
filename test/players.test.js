'use strict';

// Player extraction/aggregation against the REAL committed snapshots — the
// data is in the repo, so these are deterministic. Structural assertions
// only (presence, types, ordering), not exact stat lines.

const fs = require('fs');
const path = require('path');
const { test, summary, assert, ROOT, loadRef, makeGame } = require('./lib');
const { aggregate, extractMlb, extractEspn, NFL_GROUPS, NBA_GROUPS } = require('../tools/lib/players');
const { validateGame } = require('../tools/lib/schema');

const games = fs.readdirSync(path.join(ROOT, 'data/games'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/games', f), 'utf8')))
  .filter((g) => g.enrichment.status === 'enriched');
const loadSnap = (g) => JSON.parse(fs.readFileSync(path.join(ROOT, g.enrichment.snapshot), 'utf8'));

test('aggregate over real snapshots fills every table', () => {
  const res = aggregate(games, loadSnap);
  assert.ok(res.games >= 70, `used ${res.games} snapshots`);
  for (const [name, rows] of Object.entries(res.tables)) {
    assert.ok(rows.length > 0, `${name} is empty`);
    for (const r of rows) {
      assert.equal(typeof r.name, 'string');
      assert.ok(r.g >= 1);
    }
  }
});

test('leaders are plausible and sorted by their marquee stat', () => {
  const t = aggregate(games, loadSnap).tables;
  assert.ok(t.nflPassing.some((r) => r.name === 'Tom Brady'), 'Brady seen passing');
  const brady = t.nflPassing.find((r) => r.name === 'Tom Brady');
  assert.ok(brady.g >= 10 && brady.yds > 2000, `Brady across many games (${brady.g}g, ${brady.yds}yds)`);
  for (const [table, marquee] of [['nflPassing', 'yds'], ['mlbBatting', 'h'], ['nbaScoring', 'pts'], ['nhlScoring', 'pts']]) {
    const rows = t[table];
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1][marquee] >= rows[i][marquee], `${table} sorted by ${marquee}`);
    }
  }
});

test('extractors tolerate empty/missing boxscores', () => {
  assert.deepEqual(extractMlb({ endpoints: {} }).batting, []);
  assert.deepEqual(extractEspn({ endpoints: {} }, NFL_GROUPS).passing, []);
  assert.deepEqual(extractEspn({ endpoints: {} }, NBA_GROUPS)._default, []);
});

test('committed players.json matches a fresh aggregation', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/derived/players.json'), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(aggregate(games, loadSnap))),
    'players.json is stale — run `node tools/enrich.js --players`');
});

test('schema: event records (drafts) and soccer leagues validate', () => {
  const ref = loadRef();
  const draft = makeGame({
    league: 'nfl', home: null, away: null,
    event: { kind: 'draft', title: '2017 NFL Draft' },
    venueOverride: null,
  });
  assert.deepEqual(validateGame(draft, ref), []);
  // home null without an event stays illegal
  const bad = makeGame({ home: null });
  assert.ok(validateGame(bad, ref).some((e) => e.includes('event records')));
  // soccer league + espnLeague
  const usmnt = makeGame({ league: 'usmnt', home: 'usa', away: null, espnLeague: 'fifa.friendly' });
  assert.deepEqual(validateGame(usmnt, ref), []);
  const badEspn = makeGame({ espnLeague: '' });
  assert.ok(validateGame(badEspn, ref).some((e) => e.includes('espnLeague')));
});

summary('players.test.js');
