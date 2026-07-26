'use strict';

const path = require('path');
const { test, summary, assert, loadRef } = require('./lib');
const { parseCsv, importSheet, parseDate, matchTeam } = require('../tools/import-sheet');

const FIXTURE = path.join(__dirname, 'fixtures/sample-sheet.csv');
const { teams } = loadRef();

test('parseCsv handles quoted commas and escaped quotes', () => {
  const rows = parseCsv('a,b\n"x, y",z\n"say ""hi""",w\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'z'], ['say "hi"', 'w']]);
});

test('parseDate: M/D/YYYY, 2-digit years, fuzzy, blank', () => {
  assert.deepEqual(parseDate('9/6/1997'), { date: '1997-09-06', precision: 'day' });
  assert.deepEqual(parseDate('7/21/18'), { date: '2018-07-21', precision: 'day' });
  assert.deepEqual(parseDate('2003?'), { date: '2003', precision: 'year' });
  assert.deepEqual(parseDate('  '), { date: null, precision: 'unknown' });
  assert.throws(() => parseDate('June 5th'), /unparseable/);
});

test('matchTeam: sheet spellings, typos, and failures are loud', () => {
  assert.equal(matchTeam(teams, 'mlb', 'Boston Redsox'), 'bos');
  assert.equal(matchTeam(teams, 'nfl', 'Tennesee Titans'), 'ten'); // sheet typo, aliased
  assert.equal(matchTeam(teams, 'nfl', 'Washington Redskins'), 'was');
  assert.throws(() => matchTeam(teams, 'mlb', 'Springfield Isotopes'), /no match/);
});

test('importSheet produces valid records incl. fuzzy and no-opponent rows', () => {
  const { validateGame } = require('../tools/lib/schema');
  const ref = loadRef();
  const { records, review } = importSheet(FIXTURE);
  assert.equal(records.length, 5);
  for (const rec of records) assert.deepEqual(validateGame(rec, ref), []);

  const [r1997, fuzzy, gundy, dh, ghosts] = records;
  assert.equal(r1997.id, 'mlb-1997-09-06-mil-bos');
  assert.equal(fuzzy.id, 'mlb-2003x-ath-bos');
  assert.equal(fuzzy.datePrecision, 'year');
  assert.equal(gundy.id, 'nhl-undated-unk-nyi');
  assert.equal(gundy.away, null);
  assert.equal(gundy.notes, 'Tickets w/Gundy');
  assert.equal(dh.notes, 'Day Game of Doubleheader, BMcG Bachelor Party');
  assert.equal(ghosts.notes, '"seeing ghosts"');
  // Doubleheader note is flagged for hand review, not auto-guessed.
  assert.ok(review.some((r) => r.includes('Doubleheader')));
});

summary('import.test.js');
