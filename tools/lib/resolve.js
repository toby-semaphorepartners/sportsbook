'use strict';

// League API clients: find a game's canonical source ID from date + teams,
// and fetch the endpoint set worth snapshotting. Network code lives here and
// only here; run it from a home connection (corporate/agent proxies commonly
// 403 these hosts — detected and reported as ProxyBlockedError).

const MLB = 'https://statsapi.mlb.com/api/v1';
const NHL = 'https://api-web.nhle.com/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_PATH = { nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl' };
const UA = 'stub-book/1.0 (personal attendance tracker; one-time backfill)';

class ProxyBlockedError extends Error {
  constructor(url) {
    super(`${url} returned 403 — this network blocks sports APIs (agent/corporate proxies often do). Run enrich.js from your own machine.`);
    this.name = 'ProxyBlockedError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function fetchJson(url) {
  // Politeness: ≥1.1s between requests, one retry on transient failure.
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    } catch (err) {
      if (attempt === 0) { await sleep(2000); continue; }
      throw new Error(`${url}: ${err.message}`);
    }
    if (res.status === 403) throw new ProxyBlockedError(url);
    if (res.status >= 500 && attempt === 0) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
}

function isoShift(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const compact = (iso) => iso.replace(/-/g, '');

// ---- team matching helpers (pure) ----

function teamNames(teams, league, code) {
  const t = teams[league][code];
  return new Set([
    ...(t.aliases || []),
    ...t.eras.map((e) => e.name.toLowerCase()),
    ...(t.api && t.api.espnAbbr ? [t.api.espnAbbr.toLowerCase()] : []),
    ...(t.api && t.api.nhlAbbr ? [t.api.nhlAbbr.toLowerCase()] : []),
  ]);
}

// Does an API-side team descriptor (abbreviation or display name) mean `code`?
function espnTeamMatches(teams, league, code, competitor) {
  const names = teamNames(teams, league, code);
  const cand = [
    competitor.team && competitor.team.abbreviation,
    competitor.team && competitor.team.displayName,
    competitor.team && competitor.team.name,
    competitor.abbrev,
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  return cand.some((c) => names.has(c));
}

// ---- per-league resolvers: (game, teams) -> {sourceGameId, apiHome, apiAway} | {candidates} | null ----

async function resolveMlbOnDate(game, teams, date) {
  const homeId = teams.mlb[game.home].api.statsapiId;
  const awayId = game.away ? teams.mlb[game.away].api.statsapiId : null;
  const sched = await fetchJson(`${MLB}/schedule?sportId=1&date=${date}`);
  const games = (sched.dates || []).flatMap((d) => d.games || []);
  let matches = games.filter((g) =>
    g.teams.home.team.id === homeId && (awayId === null || g.teams.away.team.id === awayId));
  if (!matches.length && awayId !== null) {
    const flipped = games.filter((g) => g.teams.home.team.id === awayId && g.teams.away.team.id === homeId);
    if (flipped.length === 1) return { sourceGameId: String(flipped[0].gamePk), swapped: true };
  }
  if (matches.length > 1 && game.doubleheaderGame) {
    matches = matches.filter((g) => g.gameNumber === game.doubleheaderGame);
  }
  if (matches.length === 1) return { sourceGameId: String(matches[0].gamePk) };
  if (matches.length > 1) {
    return {
      candidates: matches.map((g) => ({
        sourceGameId: String(g.gamePk), date, gameNumber: g.gameNumber,
        note: `game ${g.gameNumber} of doubleheader`,
      })),
    };
  }
  return null;
}

async function resolveNhlOnDate(game, teams, date) {
  const home = teams.nhl[game.home].api.nhlAbbr;
  const away = game.away ? teams.nhl[game.away].api.nhlAbbr : null;
  const score = await fetchJson(`${NHL}/score/${date}`);
  const games = score.games || [];
  const matches = games.filter((g) =>
    g.homeTeam && g.homeTeam.abbrev === home && (away === null || (g.awayTeam && g.awayTeam.abbrev === away)));
  if (matches.length === 1) return { sourceGameId: String(matches[0].id) };
  if (!matches.length && away !== null) {
    const flipped = games.filter((g) =>
      g.homeTeam && g.homeTeam.abbrev === away && g.awayTeam && g.awayTeam.abbrev === home);
    if (flipped.length === 1) return { sourceGameId: String(flipped[0].id), swapped: true };
  }
  return null;
}

async function resolveEspnOnDate(game, teams, date, extra = '') {
  const sb = await fetchJson(`${ESPN}/${ESPN_PATH[game.league]}/scoreboard?dates=${compact(date)}${extra}`);
  const events = sb.events || [];
  // All-Star rosters carry sponsor-era names (2022 was "Team LeBron vs Team
  // Durant"), so East/West can never match by name — a lone event on the
  // right date IS the All-Star game.
  if (game.seasonType === 'allstar' && events.length === 1) {
    return { sourceGameId: String(events[0].id) };
  }
  const matches = [];
  for (const ev of events) {
    const comp = (ev.competitions || [])[0] || {};
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const homeOk = espnTeamMatches(teams, game.league, game.home, home);
    const awayOk = game.away === null || espnTeamMatches(teams, game.league, game.away, away);
    if (homeOk && awayOk) matches.push({ sourceGameId: String(ev.id) });
    else if (game.away !== null &&
      espnTeamMatches(teams, game.league, game.home, away) &&
      espnTeamMatches(teams, game.league, game.away, home)) {
      matches.push({ sourceGameId: String(ev.id), swapped: true });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Exact-date resolve with a ±1-day window for timezone skew (London games,
// late West Coast starts). The record's own date is never rewritten by this.
async function resolveGame(game, teams) {
  const onDate = { mlb: resolveMlbOnDate, nhl: resolveNhlOnDate, nfl: resolveEspnOnDate, nba: resolveEspnOnDate }[game.league];
  for (const shift of [0, 1, -1]) {
    const date = shift === 0 ? game.date : isoShift(game.date, shift);
    let hit = await onDate(game, teams, date);
    if (!hit && game.league === 'nba' && game.seasonType === 'allstar') {
      hit = await resolveEspnOnDate(game, teams, date, '&seasontype=4');
    }
    if (hit) return hit;
  }
  return null;
}

// ---- endpoint fetch + prune for the snapshot ----

function prune(obj, paths) {
  const pruned = [];
  for (const p of paths) {
    const parts = p.split('.');
    let node = obj;
    for (let i = 0; i < parts.length - 1 && node; i++) node = node[parts[i]];
    if (node && node[parts.at(-1)] !== undefined) {
      delete node[parts.at(-1)];
      pruned.push(p);
    }
  }
  return pruned;
}

async function fetchSnapshot(game, sourceGameId, teams) {
  const endpoints = {};
  let pruned = [];
  let source;
  if (game.league === 'mlb') {
    source = 'mlb';
    const feed = await fetchJson(`${MLB.replace('/v1', '/v1.1')}/game/${sourceGameId}/feed/live`);
    // feed/live is multi-MB of play-by-play; keep gameData + linescore + boxscore.
    pruned = prune(feed, ['liveData.plays', 'liveData.leaders', 'liveData.decisions']);
    endpoints.feed = feed;
  } else if (game.league === 'nhl') {
    source = 'nhl';
    endpoints.boxscore = await fetchJson(`${NHL}/gamecenter/${sourceGameId}/boxscore`);
    endpoints.landing = await fetchJson(`${NHL}/gamecenter/${sourceGameId}/landing`);
    pruned = prune(endpoints.landing, ['summary.scoring', 'summary.penalties']);
    // The NHL API doesn't expose attendance; best-effort ESPN supplement.
    try {
      const espnGame = teams && await resolveEspnOnDate(game, teams, game.date);
      if (espnGame && !espnGame.swapped) {
        const summary = await fetchJson(`${ESPN}/hockey/nhl/summary?event=${espnGame.sourceGameId}`);
        endpoints.espnSummary = { gameInfo: (summary && summary.gameInfo) || {} };
      }
    } catch (err) {
      // Attendance stays null; everything else about the snapshot is intact.
    }
  } else {
    source = 'espn';
    const summary = await fetchJson(`${ESPN}/${ESPN_PATH[game.league]}/summary?event=${sourceGameId}`);
    pruned = prune(summary, ['plays', 'drives', 'winprobability', 'videos', 'article', 'news', 'standings']);
    endpoints.summary = summary;
  }
  return { source, sourceGameId, pruned, endpoints };
}

// ---- season search for fuzzy dates ----

async function searchSeason(game, teams, seasonYear) {
  const league = game.league;
  const out = [];
  if (league === 'mlb') {
    const teamId = teams.mlb[game.home].api.statsapiId;
    const sched = await fetchJson(
      `${MLB}/schedule?sportId=1&teamId=${teamId}&startDate=${seasonYear}-03-01&endDate=${seasonYear}-11-15`);
    for (const d of sched.dates || []) {
      for (const g of d.games || []) {
        if (g.teams.home.team.id !== teamId) continue; // home games only
        if (game.away !== null && g.teams.away.team.id !== teams.mlb[game.away].api.statsapiId) continue;
        out.push({
          sourceGameId: String(g.gamePk),
          date: d.date,
          away: g.teams.away.team.name,
          score: `${g.teams.away.score ?? '?'}–${g.teams.home.score ?? '?'}`,
        });
      }
    }
  } else if (league === 'nhl') {
    const abbr = teams.nhl[game.home].api.nhlAbbr;
    const sched = await fetchJson(`${NHL}/club-schedule-season/${abbr}/${seasonYear}${seasonYear + 1}`);
    for (const g of sched.games || []) {
      if (!g.homeTeam || g.homeTeam.abbrev !== abbr) continue;
      if (game.away !== null && g.awayTeam.abbrev !== teams.nhl[game.away].api.nhlAbbr) continue;
      out.push({
        sourceGameId: String(g.id),
        date: String(g.gameDate).slice(0, 10),
        away: g.awayTeam.abbrev,
        score: g.awayTeam.score !== undefined ? `${g.awayTeam.score}–${g.homeTeam.score}` : '?',
      });
    }
  } else {
    const abbr = teams[league][game.home].api.espnAbbr;
    const sched = await fetchJson(`${ESPN}/${ESPN_PATH[league]}/teams/${abbr}/schedule?season=${seasonYear}`);
    for (const ev of sched.events || []) {
      const comp = (ev.competitions || [])[0] || {};
      const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
      const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
      if (!home || !espnTeamMatches(teams, league, game.home, home)) continue;
      if (game.away !== null && away && !espnTeamMatches(teams, league, game.away, away)) continue;
      out.push({
        sourceGameId: String(ev.id),
        date: String(ev.date).slice(0, 10),
        away: away && away.team ? away.team.displayName : '?',
        score: '?',
      });
    }
  }
  return out;
}

module.exports = {
  resolveGame, fetchSnapshot, searchSeason, fetchJson,
  espnTeamMatches, isoShift, prune, ProxyBlockedError,
};
