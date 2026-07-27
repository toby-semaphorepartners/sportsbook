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

  try {
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
