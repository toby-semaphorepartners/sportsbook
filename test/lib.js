'use strict';

// Shared test plumbing: extract DOM-free script blocks out of the template
// and evaluate them in one vm context (later blocks see earlier globals).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/template.html'), 'utf8');

function extractBlock(id) {
  const m = TEMPLATE.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`script block #${id} not found in template`);
  return m[1];
}

function evalBlocks(ids) {
  const ctx = vm.createContext({ console });
  const out = {};
  for (const id of ids) {
    ctx.module = { exports: {} };
    vm.runInContext(extractBlock(id), ctx, { filename: `template#${id}` });
    Object.assign(out, ctx.module.exports);
  }
  return out;
}

function loadRef() {
  return {
    teams: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reference/teams.json'), 'utf8')),
    venues: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reference/venues.json'), 'utf8')),
  };
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    process.exitCode = 1;
    console.error(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

function summary(file) {
  console.log(failures ? `${file}: ${failures} FAILURE(S)` : `${file}: all tests passed`);
}

// Minimal valid game record for synthetic datasets.
function makeGame(patch) {
  return Object.assign({
    id: 'test-game',
    league: 'mlb',
    date: '2015-06-01',
    datePrecision: 'day',
    home: 'nym',
    away: 'atl',
    neutralSite: false,
    seasonType: 'regular',
    doubleheaderGame: 0,
    notes: null,
    companions: [],
    seat: null,
    venueOverride: null,
    overrides: {},
    enrichment: { status: 'pending', source: null, sourceGameId: null, snapshot: null, fetchedAt: null, candidates: null, summary: null },
  }, patch);
}

module.exports = { ROOT, extractBlock, evalBlocks, loadRef, test, summary, assert, makeGame };
