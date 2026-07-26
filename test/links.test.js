'use strict';

// Golden Sports-Reference URLs across eras and site quirks. The #links block
// depends on #stats globals, so both are evaluated in one vm context.

const { test, summary, assert, evalBlocks, loadRef, makeGame } = require('./lib');

const L = evalBlocks(['stats', 'links']);
const { teams } = loadRef();
const url = (patch) => L.sportsrefUrl(makeGame(patch), teams);

test('baseball-reference: code twice, .shtml, trailing game index', () => {
  assert.equal(
    url({ league: 'mlb', home: 'bos', away: 'mil', date: '1997-09-06' }),
    'https://www.baseball-reference.com/boxes/BOS/BOS199709060.shtml'
  );
  // Retrosheet-style codes, not modern abbreviations: Cubs are CHN.
  assert.equal(
    url({ league: 'mlb', home: 'chc', away: 'stl', date: '2018-07-21', doubleheaderGame: 1 }),
    'https://www.baseball-reference.com/boxes/CHN/CHN201807211.shtml'
  );
  assert.equal(
    url({ league: 'mlb', home: 'nyy', away: 'bos', date: '2021-07-18' }),
    'https://www.baseball-reference.com/boxes/NYA/NYA202107180.shtml'
  );
});

test('pro-football-reference: lowercase legacy code, date first, .htm', () => {
  assert.equal(
    url({ league: 'nfl', home: 'nyg', away: 'was', date: '2011-12-18' }),
    'https://www.pro-football-reference.com/boxscores/201112180nyg.htm'
  );
  // Franchise codes differ from official abbreviations: NE=nwe, TEN=oti.
  assert.equal(
    url({ league: 'nfl', home: 'ne', away: 'phi', date: '2018-02-04', neutralSite: true, seasonType: 'postseason' }),
    'https://www.pro-football-reference.com/boxscores/201802040nwe.htm'
  );
  assert.equal(
    url({ league: 'nfl', home: 'ten', away: 'nyj', date: '2015-12-13' }),
    'https://www.pro-football-reference.com/boxscores/201512130oti.htm'
  );
});

test('hockey-reference: uppercase, .html', () => {
  assert.equal(
    url({ league: 'nhl', home: 'pit', away: 'wsh', date: '2011-01-01' }),
    'https://www.hockey-reference.com/boxscores/201101010PIT.html'
  );
});

test('basketball-reference: era-aware Nets code (NJN vs BRK)', () => {
  assert.equal(
    url({ league: 'nba', home: 'bkn', away: 'atl', date: '2017-04-02' }),
    'https://www.basketball-reference.com/boxscores/201704020BRK.html'
  );
  // March 2012 belongs to season 2011, the last New Jersey year.
  assert.equal(
    url({ league: 'nba', home: 'bkn', away: 'nyk', date: '2012-03-01' }),
    'https://www.basketball-reference.com/boxscores/201203010NJN.html'
  );
});

test('NBA All-Star games link to the all-star page, not a boxscore', () => {
  assert.equal(
    url({ league: 'nba', home: 'east', away: 'west', date: '2022-02-20', seasonType: 'allstar', neutralSite: true }),
    'https://www.basketball-reference.com/allstar/NBA_2022.html'
  );
});

test('no link without a day-precise date or a sportsref code', () => {
  assert.equal(url({ date: '2003', datePrecision: 'year' }), null);
  assert.equal(url({ date: null, datePrecision: 'unknown' }), null);
  assert.equal(url({ league: 'nba', home: 'east', away: 'west', date: '2022-02-20' }), null); // pseudo-team, non-allstar
});

summary('links.test.js');
