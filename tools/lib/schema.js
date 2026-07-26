'use strict';

// Game-record validation. Every rule the data files must obey lives here;
// build.js refuses to bake anything this module rejects.

const LEAGUES = ['mlb', 'nfl', 'nhl', 'nba'];
const PRECISIONS = ['day', 'year', 'unknown'];
const SEASON_TYPES = ['regular', 'postseason', 'allstar'];
const ENRICH_STATUSES = ['pending', 'enriched', 'candidates', 'unresolvable'];
const SOURCES = ['mlb', 'nhl', 'espn'];

const SUMMARY_FIELDS = {
  homeScore: 'number',
  awayScore: 'number',
  linescore: 'linescore',
  finalType: 'string',
  venue: 'string',
  attendance: 'number',
  weather: 'string',
  durationMinutes: 'number',
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_YEAR = /^\d{4}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkSummaryFields(obj, label, errors) {
  for (const key of Object.keys(obj)) {
    if (!(key in SUMMARY_FIELDS)) {
      errors.push(`${label}.${key}: unknown field`);
      continue;
    }
    const val = obj[key];
    if (val === null) continue;
    const want = SUMMARY_FIELDS[key];
    if (want === 'linescore') {
      const ok = Array.isArray(val) && val.every(
        (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number')
      );
      if (!ok) errors.push(`${label}.linescore: must be an array of [home, away] number pairs`);
    } else if (typeof val !== want) {
      errors.push(`${label}.${key}: expected ${want} or null, got ${typeof val}`);
    }
  }
}

// Returns an array of error strings; empty means valid.
// ref = { teams, venues } parsed reference tables.
function validateGame(game, ref) {
  const errors = [];
  if (!isPlainObject(game)) return ['record is not an object'];

  const { teams, venues } = ref;

  if (typeof game.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(game.id)) {
    errors.push('id: required, lowercase letters/digits/hyphens');
  }
  if (!LEAGUES.includes(game.league)) {
    errors.push(`league: must be one of ${LEAGUES.join('|')}`);
  }
  if (!PRECISIONS.includes(game.datePrecision)) {
    errors.push(`datePrecision: must be one of ${PRECISIONS.join('|')}`);
  } else if (game.datePrecision === 'day') {
    if (typeof game.date !== 'string' || !ISO_DAY.test(game.date)) {
      errors.push('date: precision "day" requires YYYY-MM-DD');
    }
  } else if (game.datePrecision === 'year') {
    if (typeof game.date !== 'string' || !ISO_YEAR.test(game.date)) {
      errors.push('date: precision "year" requires YYYY');
    }
  } else if (game.date !== null) {
    errors.push('date: precision "unknown" requires null');
  }

  const leagueTeams = LEAGUES.includes(game.league) ? teams[game.league] : null;
  if (leagueTeams) {
    if (!(game.home in leagueTeams)) errors.push(`home: unknown ${game.league} team "${game.home}"`);
    if (game.away !== null && !(game.away in leagueTeams)) {
      errors.push(`away: unknown ${game.league} team "${game.away}" (use null for unknown opponent)`);
    }
    if (game.away !== null && game.away === game.home) errors.push('away: must differ from home');
  }

  if (typeof game.neutralSite !== 'boolean') errors.push('neutralSite: must be boolean');
  if (!SEASON_TYPES.includes(game.seasonType)) {
    errors.push(`seasonType: must be one of ${SEASON_TYPES.join('|')}`);
  }
  if (![0, 1, 2].includes(game.doubleheaderGame)) errors.push('doubleheaderGame: must be 0, 1, or 2');
  if (game.notes !== null && typeof game.notes !== 'string') errors.push('notes: string or null');
  if (!Array.isArray(game.companions) || game.companions.some((c) => typeof c !== 'string')) {
    errors.push('companions: must be an array of strings');
  }
  if (game.seat !== null && typeof game.seat !== 'string') errors.push('seat: string or null');
  if (game.venueOverride !== null) {
    if (typeof game.venueOverride !== 'string' || !(game.venueOverride in venues.venues)) {
      errors.push(`venueOverride: unknown venue "${game.venueOverride}"`);
    }
  }
  if (!isPlainObject(game.overrides)) {
    errors.push('overrides: must be an object');
  } else {
    checkSummaryFields(game.overrides, 'overrides', errors);
  }

  const e = game.enrichment;
  if (!isPlainObject(e)) {
    errors.push('enrichment: must be an object');
    return errors;
  }
  if (!ENRICH_STATUSES.includes(e.status)) {
    errors.push(`enrichment.status: must be one of ${ENRICH_STATUSES.join('|')}`);
  }
  if (e.status === 'enriched') {
    if (!SOURCES.includes(e.source)) errors.push('enrichment.source: required when enriched');
    if (typeof e.sourceGameId !== 'string' || !e.sourceGameId) {
      errors.push('enrichment.sourceGameId: required when enriched');
    }
    if (typeof e.snapshot !== 'string' || !e.snapshot.startsWith('data/snapshots/')) {
      errors.push('enrichment.snapshot: required path under data/snapshots/ when enriched');
    }
    if (!isPlainObject(e.summary)) errors.push('enrichment.summary: required when enriched');
  }
  if (e.status === 'candidates' && !Array.isArray(e.candidates)) {
    errors.push('enrichment.candidates: required array when status is "candidates"');
  }
  if (isPlainObject(e.summary)) checkSummaryFields(e.summary, 'enrichment.summary', errors);
  if (e.summary && isPlainObject(e.summary) && e.summary.venue != null && !(e.summary.venue in venues.venues)) {
    errors.push(`enrichment.summary.venue: unknown venue key "${e.summary.venue}"`);
  }

  // Enriched games with a known opponent must carry a final score.
  if (e.status === 'enriched' && game.away !== null && isPlainObject(e.summary)) {
    if (typeof e.summary.homeScore !== 'number' || typeof e.summary.awayScore !== 'number') {
      errors.push('enrichment.summary: enriched game needs numeric homeScore/awayScore');
    }
  }

  return errors;
}

module.exports = { validateGame, LEAGUES, SUMMARY_FIELDS };
