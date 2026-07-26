'use strict';

// Normalizers against recorded-shape fixtures. No network, ever — these
// fixtures were authored from the documented API shapes; if a real response
// disagrees, fix the normalizer AND update the fixture to the real shape.

const fs = require('fs');
const path = require('path');
const { test, summary, assert, loadRef } = require('./lib');
const { normalize, mapVenue } = require('../tools/lib/normalize');
const { isoShift, prune, espnTeamMatches } = require('../tools/lib/resolve');

const { teams, venues } = loadRef();
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('MLB 1997: score, linescore, attendance, duration; empty weather stays null', () => {
  const { summary: s, warnings } = normalize(fixture('mlb-1997-fenway.json'), venues);
  assert.equal(s.homeScore, 7);
  assert.equal(s.awayScore, 4);
  assert.equal(s.linescore.length, 9);
  assert.deepEqual(s.linescore[0], [2, 0]);
  assert.deepEqual(s.linescore[8], [0, 1]); // home didn't bat in the 9th -> 0
  assert.equal(s.finalType, 'F');
  assert.equal(s.venue, 'fenway-park');
  assert.equal(s.attendance, 30119);
  assert.equal(s.durationMinutes, 165);
  assert.equal(s.weather, null);
  assert.deepEqual(warnings, []);
});

test('MLB extras: 10-inning game gets F/10 and composed weather string', () => {
  const { summary: s } = normalize(fixture('mlb-modern-extras.json'), venues);
  assert.equal(s.finalType, 'F/10');
  assert.equal(s.linescore.length, 10);
  assert.equal(s.weather, 'Partly Cloudy, 74°F, wind 9 mph, L To R');
  assert.equal(s.venue, 'pnc-park');
});

test('NHL: shootout finalType, venue, linescore; missing attendance stays null', () => {
  const { summary: s, warnings } = normalize(fixture('nhl-shootout.json'), venues);
  assert.equal(s.homeScore, 3);
  assert.equal(s.awayScore, 2);
  assert.equal(s.finalType, 'F/SO');
  assert.equal(s.venue, 'prudential-center');
  assert.equal(s.attendance, null); // NHL API doesn't expose it reliably
  assert.equal(s.linescore.length, 4);
  assert.deepEqual(warnings, []);
});

test('NHL: an ESPN supplement endpoint fills attendance in', () => {
  const snap = fixture('nhl-shootout.json');
  snap.endpoints.espnSummary = { gameInfo: { attendance: 16514 } };
  const { summary: s } = normalize(snap, venues);
  assert.equal(s.attendance, 16514);
});

test('ESPN NFL (Super Bowl LII): scores, quarters, venue, attendance', () => {
  const { summary: s, warnings } = normalize(fixture('espn-superbowl-lii.json'), venues);
  assert.equal(s.homeScore, 33); // Patriots were the designated home team
  assert.equal(s.awayScore, 41);
  assert.deepEqual(s.linescore, [[3, 9], [9, 13], [14, 7], [7, 12]]);
  assert.equal(s.finalType, 'F');
  assert.equal(s.venue, 'us-bank-stadium');
  assert.equal(s.attendance, 67612);
  assert.deepEqual(warnings, []);
});

test('ESPN NBA: overtime detected from status detail', () => {
  const { summary: s } = normalize(fixture('espn-nba-ot.json'), venues);
  assert.equal(s.finalType, 'F/OT');
  assert.equal(s.venue, 'barclays-center');
  assert.equal(s.linescore.length, 5);
});

test('unmapped venue: null + a warning telling you to extend venues.json', () => {
  const snap = fixture('mlb-1997-fenway.json');
  snap.endpoints.feed.gameData.venue.name = 'Estadio Alfredo Harp Helú';
  const { summary: s, warnings } = normalize(snap, venues);
  assert.equal(s.venue, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /venues\.json/);
});

test('mapVenue matches name, aka, and apiNames case-insensitively', () => {
  const w = [];
  assert.equal(mapVenue(venues, 'heinz field', w), 'acrisure-stadium');
  assert.equal(mapVenue(venues, 'Oriole Park at Camden Yards', w), 'camden-yards');
  assert.equal(mapVenue(venues, null, w), null);
  assert.deepEqual(w, []);
});

test('resolve helpers: isoShift crosses months, prune records what it removed', () => {
  assert.equal(isoShift('2025-10-12', 1), '2025-10-13');
  assert.equal(isoShift('2025-01-01', -1), '2024-12-31');
  const obj = { liveData: { plays: [1, 2], linescore: {} } };
  const pruned = prune(obj, ['liveData.plays', 'liveData.nothing']);
  assert.deepEqual(pruned, ['liveData.plays']);
  assert.equal(obj.liveData.plays, undefined);
  assert.ok(obj.liveData.linescore);
});

test('espnTeamMatches: abbreviation, era display names, never cross-team', () => {
  const comp = (abbr, name) => ({ team: { abbreviation: abbr, displayName: name } });
  assert.ok(espnTeamMatches(teams, 'nfl', 'ne', comp('NE', 'New England Patriots')));
  assert.ok(espnTeamMatches(teams, 'nfl', 'was', comp('WSH', 'Washington Redskins')));
  assert.ok(espnTeamMatches(teams, 'nba', 'bkn', comp('NJ', 'New Jersey Nets'))); // era name match
  assert.ok(!espnTeamMatches(teams, 'nfl', 'nyj', comp('NE', 'New England Patriots')));
});

summary('normalize.test.js');
