#!/usr/bin/env node
'use strict';

// Bake data/games + reference tables into src/template.html -> index.html.
// Deterministic by construction: records are sorted by id, no timestamps,
// and the JSON is emitted with JSON.stringify insertion order.

const fs = require('fs');
const path = require('path');
const { loadAll } = require('./validate');

const ROOT = path.join(__dirname, '..');

function build({ root = ROOT, outFile = path.join(ROOT, 'index.html') } = {}) {
  const { games, ref, errors, warnings } = loadAll(root);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    throw new Error(`refusing to build: ${errors.length} validation error(s)`);
  }
  for (const w of warnings) console.warn(`warn: ${w}`);

  games.sort((a, b) => (a.id < b.id ? -1 : 1));
  const playersPath = path.join(root, 'data/derived/players.json');
  const players = fs.existsSync(playersPath) ? JSON.parse(fs.readFileSync(playersPath, 'utf8')) : null;
  const data = { games, teams: ref.teams, venues: ref.venues, players };
  // <-escape so "</script>" can never terminate the data block.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const template = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
  if (!template.includes('__DATA_JSON__')) throw new Error('template is missing the __DATA_JSON__ placeholder');
  const html = template.replace('__DATA_JSON__', json);
  fs.writeFileSync(outFile, html);
  return { games: games.length, bytes: html.length, outFile };
}

if (require.main === module) {
  const res = build();
  console.log(`built ${path.relative(ROOT, res.outFile)}: ${res.games} games, ${(res.bytes / 1024).toFixed(1)} KB`);
}

module.exports = { build };
