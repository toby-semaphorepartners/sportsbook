'use strict';

// Raw snapshot -> normalized summary, one pure function per source. These are
// the only code that understands API response shapes, and they are tested
// exclusively against fixtures in test/fixtures/ — never the live APIs.
//
// A snapshot is { source, sourceGameId, fetchedAt, pruned: [], endpoints: {role: body} }.
// Every summary field is nullable; missing data is normal for old games.

function emptySummary() {
  return {
    homeScore: null,
    awayScore: null,
    linescore: null,
    finalType: 'F',
    venue: null,
    attendance: null,
    weather: null,
    durationMinutes: null,
  };
}

// Map a raw venue string to a venues.json key via apiNames/name/aka.
// Unmapped names surface as a warning so the table can be extended.
function mapVenue(venues, rawName, warnings) {
  if (!rawName) return null;
  const want = String(rawName).trim().toLowerCase();
  for (const [key, v] of Object.entries(venues.venues)) {
    const names = [v.name, ...(v.aka || []), ...(v.apiNames || [])];
    if (names.some((n) => n.trim().toLowerCase() === want)) return key;
  }
  warnings.push(`venue "${rawName}" not in venues.json — add it (with apiNames) and re-run`);
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? n : null;
}

// MLB Stats API /game/{gamePk}/feed/live
function normalizeMlb(snapshot, venues) {
  const warnings = [];
  const s = emptySummary();
  const feed = snapshot.endpoints.feed || {};
  const gameData = feed.gameData || {};
  const live = feed.liveData || {};
  const line = live.linescore || {};

  if (line.teams) {
    s.homeScore = num(line.teams.home && line.teams.home.runs);
    s.awayScore = num(line.teams.away && line.teams.away.runs);
  }
  if (Array.isArray(line.innings) && line.innings.length) {
    s.linescore = line.innings.map((inn) => [num(inn.home && inn.home.runs) || 0, num(inn.away && inn.away.runs) || 0]);
    if (line.innings.length !== 9) s.finalType = `F/${line.innings.length}`;
  }
  s.venue = mapVenue(venues, gameData.venue && gameData.venue.name, warnings);
  const info = gameData.gameInfo || {};
  s.attendance = num(info.attendance);
  s.durationMinutes = num(info.gameDurationMinutes);
  const w = gameData.weather || {};
  if (w.condition || w.temp) {
    s.weather = [w.condition, w.temp ? `${w.temp}°F` : null, w.wind ? `wind ${w.wind}` : null]
      .filter(Boolean).join(', ');
  }
  return { summary: s, warnings };
}

// NHL api-web /gamecenter/{id}/boxscore (+ /landing for the linescore).
// Attendance is unreliable in this API; the enrich CLI may add an ESPN
// supplement under endpoints.espnSummary, which we prefer for attendance.
function normalizeNhl(snapshot, venues) {
  const warnings = [];
  const s = emptySummary();
  const box = snapshot.endpoints.boxscore || {};
  const landing = snapshot.endpoints.landing || {};

  s.homeScore = num(box.homeTeam && box.homeTeam.score);
  s.awayScore = num(box.awayTeam && box.awayTeam.score);
  s.venue = mapVenue(venues, box.venue && box.venue.default, warnings);

  const outcome = (box.gameOutcome && box.gameOutcome.lastPeriodType) ||
    (landing.summary && landing.summary.gameOutcome && landing.summary.gameOutcome.lastPeriodType);
  if (outcome === 'OT') s.finalType = 'F/OT';
  else if (outcome === 'SO') s.finalType = 'F/SO';

  const rail = snapshot.endpoints.rightRail || {};
  const byPeriod =
    (rail.linescore && rail.linescore.byPeriod) ||
    (landing.summary && landing.summary.linescore && landing.summary.linescore.byPeriod);
  if (Array.isArray(byPeriod) && byPeriod.length) {
    s.linescore = byPeriod.map((p) => [num(p.home) || 0, num(p.away) || 0]);
  }

  const espn = snapshot.endpoints.espnSummary;
  if (espn && espn.gameInfo) s.attendance = num(espn.gameInfo.attendance);
  return { summary: s, warnings };
}

// ESPN site API /summary?event={id} — shared by NFL and NBA.
function normalizeEspn(snapshot, venues) {
  const warnings = [];
  const s = emptySummary();
  const sum = snapshot.endpoints.summary || {};
  const comp = (((sum.header || {}).competitions) || [])[0] || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');

  if (home && away) {
    s.homeScore = num(home.score);
    s.awayScore = num(away.score);
    const hl = home.linescores, al = away.linescores;
    if (Array.isArray(hl) && Array.isArray(al) && hl.length && hl.length === al.length) {
      s.linescore = hl.map((p, i) => [num(p.displayValue) || 0, num(al[i].displayValue) || 0]);
    }
  }
  const detail = comp.status && comp.status.type && (comp.status.type.shortDetail || comp.status.type.detail);
  if (detail && /OT/i.test(detail)) s.finalType = 'F/OT';

  const info = sum.gameInfo || {};
  s.venue = mapVenue(venues, info.venue && info.venue.fullName, warnings);
  s.attendance = num(info.attendance);
  if (info.weather) {
    const w = info.weather;
    s.weather = [w.displayValue, w.temperature != null ? `${w.temperature}°F` : null]
      .filter(Boolean).join(', ') || null;
  }
  return { summary: s, warnings };
}

function normalize(snapshot, venues) {
  if (snapshot.source === 'mlb') return normalizeMlb(snapshot, venues);
  if (snapshot.source === 'nhl') return normalizeNhl(snapshot, venues);
  if (snapshot.source === 'espn') return normalizeEspn(snapshot, venues);
  throw new Error(`unknown snapshot source "${snapshot.source}"`);
}

module.exports = { normalize, normalizeMlb, normalizeNhl, normalizeEspn, mapVenue, emptySummary };
