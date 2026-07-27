#!/usr/bin/env node
'use strict';

// Enrichment CLI: resolve each game against its league's API, snapshot the
// raw response into the repo, and write the normalized summary back into the
// record. Snapshots are fetched once and committed; the site never refetches.
//
//   node tools/enrich.js                    # all pending games with exact dates
//   node tools/enrich.js --game <id>        # just one
//   node tools/enrich.js --dry-run          # resolve + report, write nothing
//   node tools/enrich.js --search <id> [--season YYYY]   # fuzzy-date candidates
//   node tools/enrich.js --pick <id> <sourceGameId>      # finalize a candidate
//   node tools/enrich.js --force <id>       # refetch + overwrite snapshot
//   node tools/enrich.js --accept-swap      # allow home/away auto-correction
//   node tools/enrich.js --renormalize      # recompute summaries from committed
//                                           #   snapshots (offline, no fetching)
//   node tools/enrich.js --weather-nfl      # fill NFL weather from nflverse games.csv
//   node tools/enrich.js --players          # rebuild data/derived/players.json from
//                                           #   snapshots (offline "in my presence" stats)

const fs = require('fs');
const path = require('path');
const { loadRef } = require('./validate');
const { validateGame } = require('./lib/schema');
const { resolveGame, fetchSnapshot, searchSeason, ProxyBlockedError } = require('./lib/resolve');
const { normalize } = require('./lib/normalize');

const ROOT = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'data/games');

function readGame(id) {
  return JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${id}.json`), 'utf8'));
}

function writeGame(game, previousId) {
  const ref = loadRef();
  const errs = validateGame(game, ref);
  if (errs.length) throw new Error(`refusing to write ${game.id}: ${errs.join('; ')}`);
  fs.writeFileSync(path.join(GAMES_DIR, `${game.id}.json`), JSON.stringify(game, null, 2) + '\n');
  if (previousId && previousId !== game.id) fs.unlinkSync(path.join(GAMES_DIR, `${previousId}.json`));
}

function canonicalId(game) {
  if (game.datePrecision === 'day') return `${game.league}-${game.date}-${game.away || 'unk'}-${game.home}`;
  if (game.datePrecision === 'year') return `${game.league}-${game.date}x-${game.away || 'unk'}-${game.home}`;
  return game.id;
}

function weekday(iso) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T12:00:00Z').getUTCDay()];
}

async function enrichOne(game, teams, venues, opts) {
  const oldId = game.id;
  let sourceGameId = opts.sourceGameId || null;

  if (!sourceGameId) {
    const hit = await resolveGame(game, teams);
    if (!hit) {
      console.log(`  ✗ ${game.id}: no matching game found on ${game.date} (±1 day) — check date/teams, or --search`);
      return false;
    }
    if (hit.candidates) {
      game.enrichment.status = 'candidates';
      game.enrichment.candidates = hit.candidates;
      if (!opts.dryRun) writeGame(game);
      console.log(`  ? ${game.id}: multiple matches — pick one with --pick ${game.id} <sourceGameId>`);
      for (const c of hit.candidates) console.log(`      ${c.sourceGameId}  ${c.note || c.date}`);
      return false;
    }
    if (hit.swapped) {
      if (!opts.acceptSwap) {
        console.log(`  ! ${game.id}: API says home/away are SWAPPED vs the record — re-run with --accept-swap to fix the record`);
        return false;
      }
      const h = game.home; game.home = game.away; game.away = h;
      game.id = canonicalId(game);
      console.log(`  ~ ${oldId}: swapped home/away per API -> ${game.id}`);
    }
    sourceGameId = hit.sourceGameId;
  }

  if (opts.dryRun) {
    console.log(`  ✓ ${game.id}: resolved -> ${sourceGameId} (dry-run, nothing written)`);
    return true;
  }

  const snap = await fetchSnapshot(game, sourceGameId, teams);
  snap.fetchedAt = new Date().toISOString();
  const snapRel = `data/snapshots/${game.league}/${sourceGameId}.json`;
  const snapAbs = path.join(ROOT, snapRel);
  fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
  fs.writeFileSync(snapAbs, JSON.stringify(snap, null, 2) + '\n');

  const { summary, warnings } = normalize(snap, loadRef().venues);
  for (const w of warnings) console.warn(`  warn ${game.id}: ${w}`);

  game.enrichment = {
    status: 'enriched',
    source: snap.source,
    sourceGameId,
    snapshot: snapRel,
    fetchedAt: snap.fetchedAt,
    candidates: null,
    summary,
  };
  writeGame(game, oldId);
  const score = summary.awayScore !== null ? ` ${summary.awayScore}–${summary.homeScore} (${summary.finalType})` : '';
  console.log(`  ✓ ${game.id}:${score} snapshot ${snapRel}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const opts = { dryRun: flag('--dry-run'), acceptSwap: flag('--accept-swap') };
  const { teams, venues } = loadRef();

  const enrichedGames = () => fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8')))
    .filter((g) => g.enrichment.status === 'enriched');

  const renormalizeOne = (game) => {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, game.enrichment.snapshot), 'utf8'));
    const { summary, warnings } = normalize(snap, loadRef().venues);
    for (const w of warnings) console.warn(`  warn ${game.id}: ${w}`);
    if (JSON.stringify(summary) === JSON.stringify(game.enrichment.summary)) return false;
    game.enrichment.summary = summary;
    writeGame(game);
    return true;
  };

  try {
    if (flag('--players')) {
      const { aggregate } = require('./lib/players');
      const result = aggregate(enrichedGames(), (g) =>
        JSON.parse(fs.readFileSync(path.join(ROOT, g.enrichment.snapshot), 'utf8')));
      const outPath = path.join(ROOT, 'data/derived/players.json');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
      for (const [table, rows] of Object.entries(result.tables)) {
        console.log(`  ${table}: ${rows.length} players${rows[0] ? ` (top: ${rows[0].name})` : ''}`);
      }
      console.log(`players.json rebuilt from ${result.games} snapshots. Now run: node tools/build.js`);
      return;
    }

    if (flag('--renormalize')) {
      let changed = 0, total = 0;
      for (const game of enrichedGames()) {
        total++;
        if (renormalizeOne(game)) { changed++; console.log(`  ~ ${game.id}: summary updated`); }
      }
      console.log(`renormalized ${total} game(s) from committed snapshots: ${changed} changed.${changed ? ' Now run: node tools/build.js' : ''}`);
      return;
    }

    if (flag('--weather-nfl')) {
      const { GAMES_CSV_URL, parseGames, findRow, supplementOf } = require('./lib/nflverse');
      console.log(`fetching ${GAMES_CSV_URL} …`);
      const res = await fetch(GAMES_CSV_URL, { headers: { 'User-Agent': 'stub-book/1.0' } });
      if (!res.ok) throw new Error(`games.csv: HTTP ${res.status}${res.status === 403 ? ' — this network blocks the download; run from your own machine' : ''}`);
      const rows = parseGames(await res.text());
      let filled = 0, missed = 0;
      for (const game of enrichedGames().filter((g) => g.league === 'nfl')) {
        const row = findRow(rows, game, teams);
        if (!row) { missed++; console.log(`  ? ${game.id}: no nflverse row for ${game.date}`); continue; }
        const snapPath = path.join(ROOT, game.enrichment.snapshot);
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        snap.endpoints.nflverse = supplementOf(row);
        fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n');
        if (renormalizeOne(game)) filled++;
      }
      console.log(`nflverse weather: ${filled} filled, ${missed} unmatched.${filled ? ' Now run: node tools/build.js' : ''}`);
      return;
    }

    if (val('--search')) {
      const game = readGame(val('--search'));
      const season = val('--season') ? Number(val('--season')) :
        game.datePrecision === 'year' ? Number(game.date) : null;
      if (season === null) throw new Error('undated game: pass --season YYYY to pick which season to search');
      console.log(`searching ${game.league} ${season} home games of ${game.home}${game.away ? ` vs ${game.away}` : ''}…`);
      const candidates = await searchSeason(game, teams, season);
      if (!candidates.length) { console.log('no candidates found.'); return; }
      for (const c of candidates) {
        console.log(`  ${c.sourceGameId}  ${weekday(c.date)} ${c.date}  vs ${c.away}  ${c.score}`);
      }
      game.enrichment.status = 'candidates';
      game.enrichment.candidates = candidates;
      if (!opts.dryRun) writeGame(game);
      console.log(`\n${candidates.length} candidate(s) saved — finalize with: node tools/enrich.js --pick ${game.id} <sourceGameId>`);
      return;
    }

    if (val('--pick')) {
      const game = readGame(val('--pick'));
      const chosen = args[args.indexOf('--pick') + 2];
      const cand = (game.enrichment.candidates || []).find((c) => c.sourceGameId === chosen);
      if (!cand) throw new Error(`${chosen} is not among ${game.id}'s saved candidates — run --search first`);
      const oldId = game.id;
      if (cand.date) { game.date = cand.date; game.datePrecision = 'day'; }
      if (cand.gameNumber) game.doubleheaderGame = cand.gameNumber; // b-ref URLs need the DH index
      game.id = canonicalId(game);
      game.enrichment.candidates = null;
      game.enrichment.status = 'pending';
      if (oldId !== game.id) console.log(`  ~ ${oldId} -> ${game.id}`);
      await enrichOne(game, teams, venues, { ...opts, sourceGameId: chosen });
      if (!opts.dryRun && oldId !== game.id && fs.existsSync(path.join(GAMES_DIR, `${oldId}.json`))) {
        fs.unlinkSync(path.join(GAMES_DIR, `${oldId}.json`));
      }
      return;
    }

    let targets;
    if (val('--game') || val('--force')) {
      targets = [readGame(val('--game') || val('--force'))];
      if (val('--force')) targets[0].enrichment.status = 'pending';
    } else {
      targets = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.json')).sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8')))
        .filter((g) => g.enrichment.status === 'pending' && g.datePrecision === 'day');
    }

    if (!targets.length) {
      console.log('nothing to do — no pending day-precision games. (--search handles fuzzy dates.)');
      return;
    }
    console.log(`${opts.dryRun ? 'resolving' : 'enriching'} ${targets.length} game(s)…`);
    let ok = 0, failed = 0;
    for (const game of targets) {
      try {
        (await enrichOne(game, teams, venues, opts)) ? ok++ : failed++;
      } catch (err) {
        if (err instanceof ProxyBlockedError) throw err;
        failed++;
        console.error(`  ✗ ${game.id}: ${err.message}`);
      }
    }
    console.log(`\ndone: ${ok} enriched, ${failed} skipped/failed.${ok && !opts.dryRun ? ' Now run: node tools/build.js' : ''}`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}

main();
