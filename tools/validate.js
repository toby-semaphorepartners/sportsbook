#!/usr/bin/env node
'use strict';

// Validate every record under data/games/ against the schema and reference
// tables. Exits non-zero on any error. Also usable as a library (loadAll).

const fs = require('fs');
const path = require('path');
const { validateGame } = require('./lib/schema');

const ROOT = path.join(__dirname, '..');

function loadRef(root = ROOT) {
  return {
    teams: JSON.parse(fs.readFileSync(path.join(root, 'data/reference/teams.json'), 'utf8')),
    venues: JSON.parse(fs.readFileSync(path.join(root, 'data/reference/venues.json'), 'utf8')),
  };
}

// Returns { games, errors, warnings }. Games sorted by id for determinism.
function loadAll(root = ROOT) {
  const ref = loadRef(root);
  const dir = path.join(root, 'data/games');
  const errors = [];
  const warnings = [];
  const games = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const file of files) {
    const full = path.join(dir, file);
    let game;
    try {
      game = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${err.message}`);
      continue;
    }
    const errs = validateGame(game, ref);
    for (const e of errs) errors.push(`${file}: ${e}`);
    if (game && game.id && game.id !== path.basename(file, '.json')) {
      errors.push(`${file}: id "${game.id}" does not match filename`);
    }
    if (game && game.enrichment && game.enrichment.status === 'enriched') {
      const snap = path.join(root, game.enrichment.snapshot || '');
      if (!fs.existsSync(snap)) warnings.push(`${file}: snapshot ${game.enrichment.snapshot} missing`);
    }
    games.push(game);
  }
  const seen = new Set();
  for (const g of games) {
    if (g && g.id) {
      if (seen.has(g.id)) errors.push(`duplicate id: ${g.id}`);
      seen.add(g.id);
    }
  }
  return { games, ref, errors, warnings };
}

if (require.main === module) {
  const { games, errors, warnings } = loadAll();
  for (const w of warnings) console.warn(`warn: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${errors.length} error(s) across ${games.length} game record(s).`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${games.length} game record(s) valid${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
  }
}

module.exports = { loadAll, loadRef };
