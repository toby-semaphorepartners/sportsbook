'use strict';

const { test, summary, assert, makeGame, loadRef, ROOT } = require('./lib');
const { validateGame } = require('../tools/lib/schema');
const { loadAll } = require('../tools/validate');

const ref = loadRef();
const ok = (g) => assert.deepEqual(validateGame(g, ref), []);
const bad = (g, needle) => {
  const errs = validateGame(g, ref);
  assert.ok(errs.some((e) => e.includes(needle)), `expected an error mentioning "${needle}", got: ${JSON.stringify(errs)}`);
};

test('accepts a minimal pending record', () => ok(makeGame({})));

test('accepts fuzzy-year and undated records', () => {
  ok(makeGame({ date: '2003', datePrecision: 'year' }));
  ok(makeGame({ date: null, datePrecision: 'unknown', away: null }));
});

test('rejects bad league / team / date combos', () => {
  bad(makeGame({ league: 'cricket' }), 'league');
  bad(makeGame({ home: 'nope' }), 'unknown mlb team');
  bad(makeGame({ away: 'nope' }), 'unknown mlb team');
  bad(makeGame({ away: 'nym' }), 'must differ');
  bad(makeGame({ date: '2003', datePrecision: 'day' }), 'YYYY-MM-DD');
  bad(makeGame({ date: '2003-05-01', datePrecision: 'year' }), 'YYYY');
  bad(makeGame({ date: '2003', datePrecision: 'unknown' }), 'null');
});

test('rejects unknown venueOverride and override fields', () => {
  bad(makeGame({ venueOverride: 'the-moon' }), 'unknown venue');
  bad(makeGame({ overrides: { magic: 1 } }), 'unknown field');
  ok(makeGame({ overrides: { attendance: 41234 } }));
});

test('enriched records need source, snapshot, and scores', () => {
  bad(makeGame({ enrichment: { status: 'enriched', source: null, sourceGameId: null, snapshot: null, fetchedAt: null, candidates: null, summary: null } }), 'source');
  ok(makeGame({
    enrichment: {
      status: 'enriched', source: 'mlb', sourceGameId: '531060',
      snapshot: 'data/snapshots/mlb/531060.json', fetchedAt: '2026-01-01T00:00:00Z', candidates: null,
      summary: { homeScore: 4, awayScore: 2, linescore: null, finalType: 'F', venue: 'citi-field', attendance: null, weather: null, durationMinutes: null },
    },
  }));
  bad(makeGame({
    enrichment: {
      status: 'enriched', source: 'mlb', sourceGameId: '531060',
      snapshot: 'data/snapshots/mlb/531060.json', fetchedAt: null, candidates: null,
      summary: { homeScore: null, awayScore: null },
    },
  }), 'homeScore');
  bad(makeGame({
    enrichment: {
      status: 'enriched', source: 'mlb', sourceGameId: '1',
      snapshot: 'data/snapshots/mlb/1.json', fetchedAt: null, candidates: null,
      summary: { homeScore: 4, awayScore: 2, venue: 'atlantis-dome' },
    },
  }), 'unknown venue key');
});

test('candidates status requires a candidates array', () => {
  bad(makeGame({ enrichment: { status: 'candidates', source: null, sourceGameId: null, snapshot: null, fetchedAt: null, candidates: null, summary: null } }), 'candidates');
});

test('every real record in data/games validates', () => {
  const { games, errors } = loadAll(ROOT);
  assert.equal(errors.length, 0, errors.join('; '));
  assert.ok(games.length >= 74, `expected at least 74 games, found ${games.length}`);
});

summary('schema.test.js');
