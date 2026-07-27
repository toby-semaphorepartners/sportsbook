'use strict';

// Headless-Chromium smoke test against the committed index.html.
// Mirrors higher-lower: playwright-core + system Chromium, screenshots to test/out.

const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { requireChromium, launchBrowser } = require('./browser');

async function main() {
  const chromium = requireChromium('ui.test.js');
  if (!chromium) return;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

  const problems = [];
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForSelector('.card');

  const gameCount = fs.readdirSync(path.join(ROOT, 'data/games')).filter((f) => f.endsWith('.json')).length;

  // Timeline: every record renders, dated and undated alike.
  assert.equal(await page.locator('.card').count(), gameCount, 'timeline shows every game');
  assert.ok(await page.getByText('Butt-fumble').isVisible(), 'notes are surfaced');

  // Fuzzy styling assertions are data-driven: they tighten and loosen as
  // year-only games get resolved to real dates.
  const records = fs.readdirSync(path.join(ROOT, 'data/games'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/games', f), 'utf8')));
  const yearOnly = records.filter((g) => g.datePrecision === 'year');
  const undated = records.filter((g) => g.datePrecision === 'unknown');
  assert.equal(await page.locator('.card.approx').count(), yearOnly.length + undated.length,
    'every non-day-precision card is styled approximate');
  for (const g of yearOnly) {
    assert.ok(await page.getByText('~' + g.date).first().isVisible(), `year-only game shows ~${g.date}`);
  }
  if (undated.length) assert.ok(await page.getByText('Undated').isVisible(), 'undated section exists');

  // Sports-Reference deep link golden check (Super Bowl LII). The card may
  // also carry an official-page link once enriched; the SR link is first.
  const sb = page.locator('.card[data-id="nfl-2018-02-04-phi-ne"] .boxlink a').first();
  assert.equal(await sb.getAttribute('href'), 'https://www.pro-football-reference.com/boxscores/201802040nwe.htm');

  // Era-correct naming: the 2011 Washington game says Redskins, not Commanders.
  assert.ok(await page.getByText('Washington Redskins').first().isVisible(), 'era-correct team name');

  // League filter narrows the timeline.
  await page.locator('.filters .chip[data-league="nhl"]').click();
  const nhlCards = await page.locator('.card').count();
  assert.ok(nhlCards === 9, `NHL filter shows 9 games, got ${nhlCards}`);
  await page.screenshot({ path: path.join(OUT, 'timeline-nhl.png') });
  await page.locator('.filters .chip[data-league="nhl"]').click();

  // Records view: tiles, per-team table, most-seen matchup callout.
  await page.locator('nav.tabs a[data-view="records"]').click();
  await page.waitForSelector('.tiles');
  assert.ok(await page.getByText('games attended').isVisible());
  assert.ok(await page.getByText('Most-seen matchup').isVisible());
  const patsRow = page.locator('table.teams tr', { hasText: 'New England Patriots' }).first();
  assert.equal(await patsRow.locator('td').nth(3).innerText(), '24', 'Patriots seen 24 times');

  // Delight extras: heatmap grid and companions leaderboard always render;
  // superlatives appear exactly when some game carries a final score.
  assert.ok(await page.locator('.heat .cell.q1, .heat .cell.q2, .heat .cell.q3').count() > 20, 'heatmap has filled cells');
  assert.ok(await page.locator('h2.sec', { hasText: 'Crew' }).isVisible(), 'companions leaderboard present');
  const gundyRow = page.locator('tr', { hasText: 'Gundy' }).first();
  assert.equal(await gundyRow.locator('td').nth(1).innerText(), '1');
  const anyScored = records.some((g) => {
    const s = Object.assign({}, (g.enrichment && g.enrichment.summary) || {}, g.overrides);
    return typeof s.homeScore === 'number' && typeof s.awayScore === 'number';
  });
  assert.equal(await page.locator('h2.sec', { hasText: 'Superlatives' }).count(), anyScored ? 1 : 0,
    'superlatives render exactly when scores exist');
  await page.screenshot({ path: path.join(OUT, 'records.png'), fullPage: true });

  // Venues view: completion tile, defunct badge.
  await page.locator('nav.tabs a[data-view="venues"]').click();
  await page.waitForSelector('.bar');
  assert.ok(await page.getByText('active MLB venues visited').isVisible());
  assert.ok(await page.locator('.badge', { hasText: 'Gone' }).count() >= 1, 'defunct venue badged');
  await page.screenshot({ path: path.join(OUT, 'venues.png') });

  // Tap targets: tabs and filter chips are comfortably tappable.
  await page.locator('nav.tabs a[data-view="timeline"]').click();
  await page.waitForSelector('.filters');
  for (const sel of ['nav.tabs a', '.filters .chip']) {
    const boxes = await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of boxes) assert.ok(h >= 40, `${sel} height ${h} < 40px`);
  }

  await page.screenshot({ path: path.join(OUT, 'timeline.png'), fullPage: false });
  await browser.close();

  assert.deepEqual(problems, [], `page errors:\n${problems.join('\n')}`);
  console.log('ui.test.js: all assertions passed');
}

main().catch((err) => {
  console.error('FAIL ui.test.js:', err.message);
  process.exit(1);
});
