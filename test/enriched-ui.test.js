'use strict';

// End-to-end preview of the ENRICHED site without any network: build a
// scratch repo whose game records carry summaries produced by the real
// normalizers from the recorded fixtures, then assert the enriched-only UI
// (linescores, superlatives, streaks, official links) actually renders.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { build } = require('../tools/build');
const { normalize } = require('../tools/lib/normalize');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { requireChromium, launchBrowser } = require('./browser');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stubbook-enriched-'));
  fs.mkdirSync(path.join(root, 'data/games'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'data/reference'), path.join(root, 'data/reference'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  return root;
}

function enrichedRecord(id, league, date, home, away, fixtureName, extra = {}) {
  const venues = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reference/venues.json'), 'utf8'));
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', fixtureName), 'utf8'));
  const { summary, warnings } = normalize(snap, venues);
  assert.deepEqual(warnings, [], `fixture ${fixtureName} normalizes clean`);
  return Object.assign({
    id, league, date, datePrecision: 'day', home, away,
    neutralSite: false, seasonType: 'regular', doubleheaderGame: 0,
    notes: null, companions: [], seat: null, venueOverride: null, overrides: {},
    enrichment: {
      status: 'enriched', source: snap.source, sourceGameId: snap.sourceGameId,
      snapshot: `data/snapshots/${league}/${snap.sourceGameId}.json`,
      fetchedAt: '2026-01-01T00:00:00Z', candidates: null, summary,
    },
  }, extra);
}

async function main() {
  const chromium = requireChromium('enriched-ui.test.js');
  if (!chromium) return;
  const root = makeRoot();
  const games = [
    enrichedRecord('mlb-1997-09-06-mil-bos', 'mlb', '1997-09-06', 'bos', 'mil', 'mlb-1997-fenway.json'),
    // Second straight Red Sox home win -> triggers the streaks table.
    enrichedRecord('mlb-1998-05-01-tor-bos', 'mlb', '1998-05-01', 'bos', 'tor', 'mlb-1997-fenway.json'),
    enrichedRecord('nfl-2018-02-04-phi-ne', 'nfl', '2018-02-04', 'ne', 'phi', 'espn-superbowl-lii.json',
      { neutralSite: true, seasonType: 'postseason', venueOverride: 'us-bank-stadium', notes: 'Super Bowl LII' }),
    enrichedRecord('nhl-2014-03-01-nyr-njd', 'nhl', '2014-03-01', 'njd', 'nyr', 'nhl-shootout.json'),
    enrichedRecord('nba-2017-04-02-atl-bkn', 'nba', '2017-04-02', 'bkn', 'atl', 'espn-nba-ot.json'),
  ];
  for (const g of games) {
    fs.writeFileSync(path.join(root, 'data/games', `${g.id}.json`), JSON.stringify(g, null, 2) + '\n');
  }
  const outFile = path.join(root, 'index.html');
  build({ root, outFile });

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const problems = [];
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  await page.goto('file://' + outFile);
  await page.waitForSelector('.card');

  // Timeline: scores with winner bolded, linescore tables, both link kinds.
  assert.equal(await page.locator('.card').count(), 5);
  assert.equal(await page.locator('.linescore').count(), 5, 'every enriched card shows a linescore');
  const sb = page.locator('.card[data-id="nfl-2018-02-04-phi-ne"]');
  assert.ok((await sb.locator('.score b').innerText()).includes('41'), 'SB LII winner (Eagles 41) is bolded');
  assert.equal(await sb.locator('.linescore td.tot').first().innerText(), '41');
  assert.ok(await sb.getByText('U.S. Bank Stadium').isVisible(), 'venue from enrichment');
  assert.ok(await sb.getByText('67,612').isVisible(), 'attendance rendered');
  const hrefs = await sb.locator('.boxlink a').evaluateAll((as) => as.map((a) => a.href));
  assert.deepEqual(hrefs, [
    'https://www.pro-football-reference.com/boxscores/201802040nwe.htm',
    'https://www.espn.com/nfl/game/_/gameId/400999173',
  ]);
  assert.ok(await page.locator('.card[data-id="nhl-2014-03-01-nyr-njd"]').getByText('(F/SO)').isVisible(), 'shootout tag');

  // Records: enriched-only sections are now live.
  await page.locator('nav.tabs a[data-view="records"]').click();
  await page.waitForSelector('.tiles');
  assert.ok(await page.locator('h2.sec', { hasText: 'Superlatives' }).isVisible());
  assert.ok(await page.getByText('Biggest crowd').isVisible());
  assert.ok(await page.locator('h2.sec', { hasText: 'win streaks' }).isVisible());
  const bosRow = page.locator('tr', { hasText: 'Boston Red Sox' }).first();
  assert.ok(await bosRow.isVisible(), 'Red Sox streak row present');
  assert.ok(await page.getByText('2–0').first().isVisible(), 'W-L column filled in');
  await page.screenshot({ path: path.join(OUT, 'enriched-preview.png'), fullPage: true });

  await browser.close();
  assert.deepEqual(problems, [], `page errors:\n${problems.join('\n')}`);
  console.log('enriched-ui.test.js: all assertions passed');
}

main().catch((err) => {
  console.error('FAIL enriched-ui.test.js:', err.message);
  process.exit(1);
});
