#!/usr/bin/env node
'use strict';

// One-time importer: spreadsheet CSV -> one JSON record per game under
// data/games/. Verbatim by design — special games (neutral sites, playoffs,
// doubleheaders) are flagged in the report for hand-editing, not guessed.
//
//   node tools/import-sheet.js data/import/sheet.csv [--out data/games] [--force] [--dry-run]
//   node tools/import-sheet.js --reconcile        # compare records vs manual-tally.json

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const LEAGUE_MAP = { baseball: 'mlb', football: 'nfl', hockey: 'nhl', basketball: 'nba' };
const REVIEW_KEYWORDS = /super bowl|afc |nfc |playoff|finals|all star|all-star|winter classic|london|doubleheader/i;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

function matchTeam(teams, league, raw) {
  const name = raw.trim().toLowerCase();
  if (!name) return null;
  const hits = [];
  for (const [code, team] of Object.entries(teams[league] || {})) {
    const names = (team.aliases || []).concat(team.eras.map((e) => e.name.toLowerCase()));
    if (names.includes(name)) hits.push(code);
  }
  if (hits.length !== 1) {
    throw new Error(`team "${raw}" in ${league}: ${hits.length === 0 ? 'no match' : `ambiguous (${hits.join(', ')})`} — fix aliases in teams.json or the CSV`);
  }
  return hits[0];
}

function parseDate(raw) {
  const s = raw.trim();
  if (!s) return { date: null, precision: 'unknown' };
  const fuzzy = s.match(/^(\d{4})\s*\?$/);
  if (fuzzy) return { date: fuzzy[1], precision: 'year' };
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    let [, m, d, y] = mdy;
    if (y.length === 2) y = (Number(y) < 50 ? '20' : '19') + y;
    const pad = (n) => String(n).padStart(2, '0');
    return { date: `${y}-${pad(m)}-${pad(d)}`, precision: 'day' };
  }
  throw new Error(`unparseable date "${raw}"`);
}

function makeRecord(id, league, home, away, date, precision, notes) {
  return {
    id,
    league,
    date,
    datePrecision: precision,
    home,
    away,
    neutralSite: false,
    seasonType: 'regular',
    doubleheaderGame: 0,
    notes: notes.trim() || null,
    companions: [],
    seat: null,
    venueOverride: null,
    overrides: {},
    enrichment: {
      status: 'pending',
      source: null,
      sourceGameId: null,
      snapshot: null,
      fetchedAt: null,
      candidates: null,
      summary: null,
    },
  };
}

function importSheet(csvPath, opts = {}) {
  const teams = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reference/teams.json'), 'utf8'));
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (row, name) => row[header.indexOf(name)] || '';

  const records = [];
  const review = [];
  const usedIds = new Set();
  for (const row of rows) {
    const sport = col(row, 'sport').trim().toLowerCase();
    const league = LEAGUE_MAP[sport];
    if (!league) throw new Error(`unknown sport "${col(row, 'sport')}"`);
    const home = matchTeam(teams, league, col(row, 'home'));
    const away = col(row, 'away').trim() ? matchTeam(teams, league, col(row, 'away')) : null;
    const { date, precision } = parseDate(col(row, 'date'));
    const notes = col(row, 'notes');

    let id;
    if (precision === 'day') id = `${league}-${date}-${away || 'unk'}-${home}`;
    else if (precision === 'year') id = `${league}-${date}x-${away || 'unk'}-${home}`;
    else id = `${league}-undated-${away || 'unk'}-${home}`;
    let unique = id;
    for (let n = 2; usedIds.has(unique); n++) unique = `${id}-${n}`;
    usedIds.add(unique);

    const rec = makeRecord(unique, league, home, away, date, precision, notes);
    records.push(rec);
    if (REVIEW_KEYWORDS.test(notes)) review.push(`${unique}: "${notes.trim()}"`);
  }
  return { records, review };
}

function deriveTally(records, teams) {
  const tally = {};
  for (const rec of records) {
    tally[rec.league] = tally[rec.league] || {};
    const bump = (code, idx) => {
      const name = teams[rec.league][code].eras.at(-1).name;
      tally[rec.league][name] = tally[rec.league][name] || [0, 0];
      tally[rec.league][name][idx]++;
    };
    bump(rec.home, 0);
    if (rec.away) bump(rec.away, 1);
  }
  return tally;
}

function reconcile(records, teams) {
  const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/import/manual-tally.json'), 'utf8'));
  const derived = deriveTally(records, teams);
  const lines = [];
  let mismatches = 0;
  for (const league of Object.keys(manual)) {
    if (league.startsWith('_')) continue;
    lines.push(`\n${league.toUpperCase()}  (manual home/away vs derived)`);
    // Map manual names to canonical current-era names for comparison.
    const canon = (raw) => {
      const code = matchTeam(teams, league, raw);
      return teams[league][code].eras.at(-1).name;
    };
    const seen = new Set();
    for (const [rawName, [mh, ma]] of Object.entries(manual[league])) {
      const name = canon(rawName);
      seen.add(name);
      const [dh, da] = (derived[league] || {})[name] || [0, 0];
      const ok = mh === dh && ma === da;
      if (!ok) mismatches++;
      lines.push(`  ${ok ? ' ' : '!'} ${name.padEnd(26)} ${mh}/${ma}  vs  ${dh}/${da}`);
    }
    for (const [name, [dh, da]] of Object.entries(derived[league] || {})) {
      if (!seen.has(name)) { mismatches++; lines.push(`  ! ${name.padEnd(26)} -/-  vs  ${dh}/${da} (missing from manual tally)`); }
    }
  }
  return { lines, mismatches };
}

function loadExistingRecords() {
  const dir = path.join(ROOT, 'data/games');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const teams = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reference/teams.json'), 'utf8'));

  if (args.includes('--reconcile')) {
    const records = loadExistingRecords();
    const { lines, mismatches } = reconcile(records, teams);
    console.log(lines.join('\n'));
    console.log(`\n${mismatches === 0 ? 'ok: derived counts match the manual tally exactly.' : `${mismatches} mismatch(es) — investigate.`}`);
    if (mismatches) process.exitCode = 1;
  } else {
    const csvPath = args.find((a) => !a.startsWith('--'));
    if (!csvPath) { console.error('usage: node tools/import-sheet.js <sheet.csv> [--out dir] [--force] [--dry-run]'); process.exit(1); }
    const outIdx = args.indexOf('--out');
    const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'data/games');
    const { records, review } = importSheet(csvPath);

    const counts = {};
    let fuzzy = 0, undated = 0, noOpponent = 0;
    for (const r of records) {
      counts[r.league] = (counts[r.league] || 0) + 1;
      if (r.datePrecision === 'year') fuzzy++;
      if (r.datePrecision === 'unknown') undated++;
      if (r.away === null) noOpponent++;
    }

    if (!args.includes('--dry-run')) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const rec of records) {
        const file = path.join(outDir, `${rec.id}.json`);
        if (fs.existsSync(file) && !args.includes('--force')) {
          throw new Error(`${file} exists — this is a one-time import; pass --force to overwrite`);
        }
        fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
      }
    }

    console.log(`imported ${records.length} games: ${Object.entries(counts).map(([l, n]) => `${l} ${n}`).join(', ')}`);
    console.log(`fuzzy-year dates: ${fuzzy}, undated: ${undated}, unknown opponent: ${noOpponent}`);
    if (review.length) {
      console.log('\nreview these records by hand (neutral site / season type / doubleheader?):');
      for (const r of review) console.log(`  - ${r}`);
    }
    const { lines, mismatches } = reconcile(records, teams);
    console.log(lines.join('\n'));
    console.log(`\nreconciliation vs manual tally: ${mismatches === 0 ? 'exact match ✓' : `${mismatches} mismatch(es)`}`);
  }
}

module.exports = { parseCsv, importSheet, parseDate, matchTeam, deriveTally };
