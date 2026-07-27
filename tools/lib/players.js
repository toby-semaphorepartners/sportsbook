'use strict';

// "In my presence" player stats: extract per-player lines from the committed
// snapshots and aggregate them across attended games. Fully offline — run via
// `node tools/enrich.js --players` whenever games are added or re-enriched.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- per-source extractors: snapshot -> {batting?, pitching?, skaters?, groups?} ----

function extractMlb(snapshot) {
  const box = (((snapshot.endpoints.feed || {}).liveData) || {}).boxscore;
  const out = { batting: [], pitching: [] };
  if (!box || !box.teams) return out;
  for (const side of ['home', 'away']) {
    const players = (box.teams[side] || {}).players || {};
    for (const p of Object.values(players)) {
      const name = p.person && p.person.fullName;
      if (!name) continue;
      const b = (p.stats || {}).batting;
      if (b && (num(b.plateAppearances) > 0 || num(b.atBats) > 0)) {
        out.batting.push({ name, side, h: num(b.hits), hr: num(b.homeRuns), rbi: num(b.rbi), r: num(b.runs) });
      }
      const pi = (p.stats || {}).pitching;
      if (pi && (pi.inningsPitched !== undefined && pi.inningsPitched !== '0.0')) {
        out.pitching.push({ name, side, k: num(pi.strikeOuts), outs: num(pi.outs) });
      }
    }
  }
  return out;
}

function extractNhl(snapshot) {
  const pbs = (snapshot.endpoints.boxscore || {}).playerByGameStats;
  const out = { skaters: [] };
  if (!pbs) return out;
  for (const [key, side] of [['homeTeam', 'home'], ['awayTeam', 'away']]) {
    for (const group of ['forwards', 'defense']) {
      for (const p of (pbs[key] || {})[group] || []) {
        const name = p.name && (p.name.default || p.name);
        if (!name) continue;
        out.skaters.push({ name, side, g: num(p.goals), a: num(p.assists), pts: num(p.points) });
      }
    }
  }
  return out;
}

// ESPN (NFL + NBA): boxscore.players[team].statistics[group] with parallel
// labels/athletes arrays. Index stats by label so column order changes don't bite.
function extractEspn(snapshot, wantedGroups) {
  const teams = ((snapshot.endpoints.summary || {}).boxscore || {}).players || [];
  const out = {};
  for (const g of Object.keys(wantedGroups)) out[g] = [];
  teams.forEach((team, ti) => {
    const side = ti === 0 ? 'first' : 'second'; // ESPN order isn't reliably home-first; side resolved by caller if needed
    for (const group of team.statistics || []) {
      // NBA ships one unnamed group per team; NFL names them (passing, ...).
      const want = wantedGroups[group.name || '_default'];
      if (!want) continue;
      const labels = group.labels || [];
      for (const a of group.athletes || []) {
        const name = a.athlete && a.athlete.displayName;
        const stats = a.stats || [];
        if (!name || stats.length !== labels.length) continue;
        const row = { name, side };
        let keep = false;
        for (const [field, label] of Object.entries(want)) {
          row[field] = num(String(stats[labels.indexOf(label)]).replace(/[^\d.-]/g, ''));
          if (row[field] > 0) keep = true;
        }
        if (keep) out[group.name || '_default'].push(row);
      }
    }
  });
  return out;
}

const NFL_GROUPS = {
  passing: { yds: 'YDS', td: 'TD' },
  rushing: { yds: 'YDS', td: 'TD' },
  receiving: { yds: 'YDS', td: 'TD', rec: 'REC' },
};
const NBA_GROUPS = { _default: { pts: 'PTS', reb: 'REB', ast: 'AST' } };

// ---- aggregation across games ----

function addTo(map, name, fields) {
  const row = map.get(name) || { name, g: 0 };
  row.g++;
  for (const [k, v] of Object.entries(fields)) row[k] = (row[k] || 0) + v;
  map.set(name, row);
}

function top(map, marquee, n = 25) {
  return [...map.values()]
    .filter((r) => r[marquee] > 0)
    .sort((a, b) => b[marquee] - a[marquee] || b.g - a.g || (a.name < b.name ? -1 : 1))
    .slice(0, n);
}

// games: enriched game records; loadSnapshot: (game) -> parsed snapshot JSON.
function aggregate(games, loadSnapshot) {
  const maps = {
    mlbBatting: new Map(), mlbPitching: new Map(),
    nflPassing: new Map(), nflRushing: new Map(), nflReceiving: new Map(),
    nbaScoring: new Map(), nhlScoring: new Map(),
  };
  let used = 0;
  for (const game of games) {
    let snap;
    try { snap = loadSnapshot(game); } catch { continue; }
    used++;
    if (game.league === 'mlb') {
      const { batting, pitching } = extractMlb(snap);
      for (const b of batting) addTo(maps.mlbBatting, b.name, { h: b.h, hr: b.hr, rbi: b.rbi, r: b.r });
      for (const p of pitching) addTo(maps.mlbPitching, p.name, { k: p.k, outs: p.outs });
    } else if (game.league === 'nhl') {
      for (const s of extractNhl(snap).skaters) addTo(maps.nhlScoring, s.name, { goals: s.g, assists: s.a, pts: s.pts });
    } else if (game.league === 'nfl') {
      const g = extractEspn(snap, NFL_GROUPS);
      for (const p of g.passing) addTo(maps.nflPassing, p.name, { yds: p.yds, td: p.td });
      for (const p of g.rushing) addTo(maps.nflRushing, p.name, { yds: p.yds, td: p.td });
      for (const p of g.receiving) addTo(maps.nflReceiving, p.name, { yds: p.yds, td: p.td, rec: p.rec });
    } else if (game.league === 'nba') {
      const g = extractEspn(snap, NBA_GROUPS);
      for (const p of g._default) addTo(maps.nbaScoring, p.name, { pts: p.pts, reb: p.reb, ast: p.ast });
    }
  }
  return {
    games: used,
    tables: {
      mlbBatting: top(maps.mlbBatting, 'h'),
      mlbPitching: top(maps.mlbPitching, 'k'),
      nflPassing: top(maps.nflPassing, 'yds'),
      nflRushing: top(maps.nflRushing, 'yds'),
      nflReceiving: top(maps.nflReceiving, 'yds'),
      nbaScoring: top(maps.nbaScoring, 'pts'),
      nhlScoring: top(maps.nhlScoring, 'pts'),
    },
  };
}

module.exports = { extractMlb, extractNhl, extractEspn, aggregate, NFL_GROUPS, NBA_GROUPS };
