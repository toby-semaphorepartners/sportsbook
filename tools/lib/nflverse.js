'use strict';

// nflverse games.csv supplement: temp/wind/roof for every NFL game 1999+.
// ESPN's historical summaries carry no weather, so this is the weather source.
// Dataset: https://github.com/nflverse/nfldata (data/games.csv, CC-attribution).

const { parseCsv } = require('../import-sheet');

const GAMES_CSV_URL = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';

function parseGames(csvText) {
  const rows = parseCsv(csvText);
  const header = rows.shift();
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['gameday', 'away_team', 'home_team', 'temp', 'wind', 'roof']) {
    if (!(need in idx)) throw new Error(`games.csv is missing the "${need}" column — dataset layout changed?`);
  }
  return rows.map((r) => ({
    gameday: r[idx.gameday],
    away: r[idx.away_team],
    home: r[idx.home_team],
    temp: r[idx.temp],
    wind: r[idx.wind],
    roof: r[idx.roof],
    surface: r[idx.surface] ?? '',
    stadium: r[idx.stadium] ?? '',
  }));
}

function abbrMatches(teams, code, abbr) {
  const t = teams.nfl[code];
  if (!t) return false;
  const names = new Set((t.aliases || []).concat(t.api && t.api.espnAbbr ? [t.api.espnAbbr.toLowerCase()] : []));
  return names.has(String(abbr).toLowerCase());
}

// Find the nflverse row for a game record (exact date + both teams,
// designated home/away — nflverse keeps the designation for neutral sites).
function findRow(rows, game, teams) {
  const hits = rows.filter((r) =>
    r.gameday === game.date &&
    abbrMatches(teams, game.home, r.home) &&
    (game.away === null || abbrMatches(teams, game.away, r.away)));
  return hits.length === 1 ? hits[0] : null;
}

// The slice of a row worth committing into a snapshot.
function supplementOf(row) {
  return {
    temp: row.temp === '' ? null : Number(row.temp),
    wind: row.wind === '' ? null : Number(row.wind),
    roof: row.roof || null,
    surface: row.surface || null,
    stadium: row.stadium || null,
  };
}

module.exports = { GAMES_CSV_URL, parseGames, findRow, supplementOf };
