'use strict';

// The #stats block extracted from the template, run against both synthetic
// datasets and the real reference tables.

const { test, summary, assert, evalBlocks, loadRef, makeGame } = require('./lib');

const S = evalBlocks(['stats']);
const { teams, venues } = loadRef();

test('seasonYear: summer leagues use calendar year, winter leagues roll back', () => {
  assert.equal(S.seasonYear('mlb', '2013-05-10'), 2013);
  assert.equal(S.seasonYear('nfl', '2017-09-10'), 2017);
  assert.equal(S.seasonYear('nfl', '2018-02-04'), 2017); // Super Bowl LII = 2017 season
  assert.equal(S.seasonYear('nhl', '2012-01-17'), 2011);
  assert.equal(S.seasonYear('nba', '2021-05-25'), 2020);
  assert.equal(S.seasonYear('nba', '2003'), 2003); // year-only precision
});

test('teamName is era-correct', () => {
  assert.equal(S.teamName(teams, 'nfl', 'was', 2011), 'Washington Redskins');
  assert.equal(S.teamName(teams, 'nfl', 'was', 2022), 'Washington Commanders');
  assert.equal(S.teamName(teams, 'nba', 'bkn', 2011), 'New Jersey Nets');
  assert.equal(S.teamName(teams, 'nba', 'bkn', 2016), 'Brooklyn Nets');
  assert.equal(S.teamName(teams, 'mlb', 'cle', 2016), 'Cleveland Indians');
  assert.equal(S.teamName(teams, 'mlb', 'cle', null), 'Cleveland Guardians'); // undated -> current
});

test('sportsrefCode is era-correct', () => {
  assert.equal(S.sportsrefCode(teams, 'nba', 'bkn', 2011), 'NJN');
  assert.equal(S.sportsrefCode(teams, 'nba', 'bkn', 2012), 'BRK');
  assert.equal(S.sportsrefCode(teams, 'mlb', 'ath', 2009), 'OAK');
  assert.equal(S.sportsrefCode(teams, 'mlb', 'ath', 2025), 'ATH');
  assert.equal(S.sportsrefCode(teams, 'nfl', 'ten', 2015), 'oti');
  assert.equal(S.sportsrefCode(teams, 'nba', 'east', 2022), null); // all-star pseudo-team
});

test('summaryOf merges overrides over enrichment', () => {
  const g = makeGame({
    overrides: { attendance: 99999 },
    enrichment: {
      status: 'enriched', source: 'mlb', sourceGameId: 'x', snapshot: 'data/snapshots/mlb/x.json',
      fetchedAt: null, candidates: null,
      summary: { homeScore: 4, awayScore: 2, attendance: 41234, venue: 'citi-field' },
    },
  });
  const s = S.summaryOf(g);
  assert.equal(s.attendance, 99999);
  assert.equal(s.homeScore, 4);
});

test('winnerOf handles wins, ties, and unknowns', () => {
  const withScore = (h, a) => makeGame({
    enrichment: { status: 'enriched', source: 'mlb', sourceGameId: 'x', snapshot: 'data/snapshots/mlb/x.json', fetchedAt: null, candidates: null, summary: { homeScore: h, awayScore: a } },
  });
  assert.equal(S.winnerOf(withScore(4, 2)), 'home');
  assert.equal(S.winnerOf(withScore(2, 4)), 'away');
  assert.equal(S.winnerOf(withScore(3, 3)), 'tie');
  assert.equal(S.winnerOf(makeGame({})), null); // no scores yet
  const noOpp = withScore(4, 2); noOpp.away = null;
  assert.equal(S.winnerOf(noOpp), null); // unknown opponent never scores a W-L
});

test('venueKeyOf: override > enriched > era-aware inference; neutral never inferred', () => {
  // Mets home games straddle the Shea -> Citi move.
  assert.equal(S.venueKeyOf(makeGame({ date: '2005-06-01' }), venues), 'shea-stadium');
  assert.equal(S.venueKeyOf(makeGame({ date: '2013-05-10' }), venues), 'citi-field');
  // Islanders winter season split: Jan 2013 belongs to season 2012 (Nassau),
  // Oct 2015 to season 2015 (Barclays).
  const isles = (date) => makeGame({ league: 'nhl', home: 'nyi', away: 'bos', date });
  assert.equal(S.venueKeyOf(isles('2013-01-05'), venues), 'nassau-coliseum');
  assert.equal(S.venueKeyOf(isles('2015-10-23'), venues), 'barclays-center');
  // Neutral site with no override or enrichment stays unknown.
  assert.equal(S.venueKeyOf(makeGame({ neutralSite: true }), venues), null);
  // Explicit override wins.
  assert.equal(S.venueKeyOf(makeGame({ venueOverride: 'us-bank-stadium' }), venues), 'us-bank-stadium');
  // Undated: no inference possible.
  assert.equal(S.venueKeyOf(makeGame({ date: null, datePrecision: 'unknown' }), venues), null);
});

test('sortKey: day precise, year-only sorts to year end, unknown empty', () => {
  assert.equal(S.sortKey(makeGame({})), '2015-06-01');
  assert.ok(S.sortKey(makeGame({ date: '2003', datePrecision: 'year' })) > '2003-10-01');
  assert.equal(S.sortKey(makeGame({ date: null, datePrecision: 'unknown' })), '');
});

test('deriveStats aggregates counts, W-L-T, matchups, venues', () => {
  const enriched = (patch, h, a) => makeGame(Object.assign({
    enrichment: { status: 'enriched', source: 'espn', sourceGameId: 'x', snapshot: 'data/snapshots/nfl/x.json', fetchedAt: null, candidates: null, summary: { homeScore: h, awayScore: a } },
  }, patch));
  const games = [
    enriched({ id: 'a', league: 'nfl', home: 'nyj', away: 'ne', date: '2016-11-27' }, 17, 22),   // NE road win
    enriched({ id: 'b', league: 'nfl', home: 'ne', away: 'nyj', date: '2014-10-16' }, 27, 25),   // NE home win
    enriched({ id: 'c', league: 'nfl', home: 'nyj', away: 'ne', date: '2013-10-20' }, 30, 27),   // NYJ win
    enriched({ id: 'd', league: 'nfl', home: 'mia', away: 'buf', date: '2018-12-02' }, 21, 21),  // tie
    makeGame({ id: 'e', league: 'mlb', home: 'nym', away: 'atl', date: '2013-05-10' }),          // no score yet
    makeGame({ id: 'f', league: 'nhl', home: 'nyi', away: null, date: null, datePrecision: 'unknown' }),
  ];
  const st = S.deriveStats({ games, teams, venues });
  assert.equal(st.totalGames, 6);
  // JSON round-trip: st.byLeague was built inside the vm realm, whose Object
  // prototype differs from the test realm's — strict deepEqual would balk.
  assert.deepEqual(JSON.parse(JSON.stringify(st.byLeague)), { nfl: 4, mlb: 1, nhl: 1 });
  assert.equal(st.firstDate, '2013-05-10');
  assert.equal(st.lastDate, '2018-12-02');
  assert.equal(st.undated, 1);

  const ne = st.teamRows.find((r) => r.league === 'nfl' && r.code === 'ne');
  assert.deepEqual([ne.home, ne.away, ne.total, ne.w, ne.l, ne.t], [1, 2, 3, 2, 1, 0]);
  const mia = st.teamRows.find((r) => r.code === 'mia');
  assert.deepEqual([mia.w, mia.l, mia.t], [0, 0, 1]);
  const nyi = st.teamRows.find((r) => r.code === 'nyi');
  assert.deepEqual([nyi.home, nyi.away, nyi.w, nyi.l, nyi.t], [1, 0, 0, 0, 0]); // null-away: counted, no W-L

  assert.equal(st.matchupRows[0].count, 3); // Jets-Patriots x3
  assert.deepEqual([st.matchupRows[0].a, st.matchupRows[0].b].sort(), ['ne', 'nyj']);

  const citi = st.venueRows.find((v) => v.key === 'citi-field');
  assert.equal(citi.games, 1); // inferred from Mets home game
});

test('deriveStats venue completion counts only active buildings', () => {
  const games = [
    makeGame({ id: 'g1', league: 'mlb', home: 'atl', away: 'bos', date: '2007-06-18' }), // Turner Field (closed)
    makeGame({ id: 'g2', league: 'mlb', home: 'bos', away: 'atl', date: '2014-05-07' }), // Fenway (active)
  ];
  const st = S.deriveStats({ games, teams, venues });
  assert.equal(st.visitedActive.mlb, 1);
  assert.equal(st.activeVenues.mlb, 30);
  assert.equal(st.defunct.length, 1);
  assert.equal(st.defunct[0].key, 'turner-field');
});

const scored = (patch, h, a) => makeGame(Object.assign({
  enrichment: { status: 'enriched', source: 'espn', sourceGameId: 'x', snapshot: 'data/snapshots/nfl/x.json', fetchedAt: null, candidates: null, summary: { homeScore: h, awayScore: a } },
}, patch));

test('heatmap: day-precision games bucketed by year × month, fuzzy excluded', () => {
  const hm = S.heatmap([
    makeGame({ id: 'h1', date: '1997-09-06' }),
    makeGame({ id: 'h2', date: '1999-09-10' }),
    makeGame({ id: 'h3', date: '1999-09-20' }),
    makeGame({ id: 'h4', date: '2003', datePrecision: 'year' }),
  ]);
  assert.equal(hm.years.length, 3); // 1997..1999, fuzzy 2003 excluded
  assert.equal(hm.grid[1997][8], 1);
  assert.equal(hm.grid[1999][8], 2);
  assert.equal(hm.max, 2);
});

test('teamStreaks: consecutive attended wins; unscored games skip, losses reset', () => {
  const games = [
    scored({ id: 's1', league: 'nfl', home: 'nyj', away: 'ne', date: '2016-01-01' }, 10, 20), // NE win
    makeGame({ id: 's2', league: 'nfl', home: 'nyj', away: 'ne', date: '2016-06-01' }),       // no score: skipped
    scored({ id: 's3', league: 'nfl', home: 'ne', away: 'nyj', date: '2017-01-01' }, 30, 3),  // NE win (streak 2)
    scored({ id: 's4', league: 'nfl', home: 'nyj', away: 'ne', date: '2018-01-01' }, 21, 14), // NE loss: reset
    scored({ id: 's5', league: 'nfl', home: 'nyj', away: 'ne', date: '2019-01-01' }, 7, 28),  // NE win
  ];
  const rows = S.teamStreaks(games, teams);
  const ne = rows.find((r) => r.code === 'ne');
  assert.deepEqual([ne.len, ne.end], [2, '2017-01-01']);
  // Jets never won twice in a row -> below the >=2 cutoff.
  assert.equal(rows.find((r) => r.code === 'nyj'), undefined);
});

test('superlatives: extremes from enriched fields, temps parsed from weather', () => {
  const g1 = scored({ id: 'p1' }, 4, 2);
  g1.enrichment.summary.attendance = 67612;
  g1.enrichment.summary.weather = 'Sunny, 91°F, wind 5 mph';
  g1.enrichment.summary.durationMinutes = 190;
  const g2 = scored({ id: 'p2' }, 3, 17);
  g2.enrichment.summary.attendance = 15242;
  g2.enrichment.summary.weather = 'Snow, 21°F';
  g2.enrichment.summary.finalType = 'F/OT';
  const sup = S.superlatives([g1, g2, makeGame({ id: 'p3' })]);
  assert.equal(sup.biggestCrowd.value, 67612);
  assert.equal(sup.longestGame.value, 190);
  assert.equal(sup.hottest.value, 91);
  assert.equal(sup.coldest.value, 21);
  assert.equal(sup.biggestMargin.value, 14);
  assert.equal(sup.extraTime, 1);
});

test('superlatives: all-null before enrichment', () => {
  const sup = S.superlatives([makeGame({})]);
  assert.equal(sup.biggestCrowd, null);
  assert.equal(sup.extraTime, 0);
});

test('companionCounts tallies and sorts', () => {
  const rows = S.companionCounts([
    makeGame({ id: 'c1', companions: ['Gundy', 'Colin'] }),
    makeGame({ id: 'c2', companions: ['Gundy'] }),
    makeGame({ id: 'c3' }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { name: 'Gundy', count: 2 },
    { name: 'Colin', count: 1 },
  ]);
});

test('cityDots aggregates metros with coordinates; venues drive the map', () => {
  const dots = S.cityDots([
    makeGame({ id: 'm1', date: '2013-05-10' }),                                  // Citi -> New York
    makeGame({ id: 'm2', league: 'nfl', home: 'ne', away: 'nyj', date: '2014-10-16' }), // Gillette -> Boston
    makeGame({ id: 'm3', league: 'nfl', home: 'nyj', away: 'ne', date: '2014-12-21' }), // MetLife -> New York
  ], venues);
  assert.equal(dots[0].name, 'New York');
  assert.equal(dots[0].games, 2);
  assert.equal(typeof dots[0].lat, 'number');
  assert.equal(dots.find((d) => d.name === 'Boston').games, 1);
});

test('deriveStats: event records count as games but never as teams/matchups', () => {
  const draft = makeGame({
    id: 'ev1', league: 'nfl', home: null, away: null,
    event: { kind: 'draft', title: '2017 NFL Draft' },
  });
  const st = S.deriveStats({ games: [draft, makeGame({ id: 'g1' })], teams, venues });
  assert.equal(st.totalGames, 2);
  assert.equal(st.teamRows.filter((r) => r.league === 'nfl').length, 0); // draft made no team rows
  assert.equal(st.matchupRows.length, 1); // only the real mlb game's matchup
});

summary('stats.test.js');
