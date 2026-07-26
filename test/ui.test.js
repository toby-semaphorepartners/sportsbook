'use strict';

// Headless-Chromium smoke test against the committed index.html.
// Mirrors higher-lower: playwright-core + system Chromium, screenshots to test/out.

const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

// Pinned system Chromium when present (this repo's usual environments);
// otherwise playwright's own registry install (CI).
function launchOpts() {
  const p = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
  return fs.existsSync(p) ? { executablePath: p } : {};
}

async function main() {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(launchOpts());
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
  assert.ok(await page.locator('.card.approx').count() >= 2, 'fuzzy-date cards styled as approximate');
  assert.ok(await page.getByText('~2003').isVisible(), 'year-only date shows as ~year');
  assert.ok(await page.getByText('Undated').isVisible(), 'undated section exists');

  // Sports-Reference deep link golden check (Super Bowl LII).
  const sb = page.locator('.card[data-id="nfl-2018-02-04-phi-ne"] .boxlink a');
  assert.equal(await sb.getAttribute('href'), 'https://www.pro-football-reference.com/boxscores/201802040nwe.htm');

  // Era-correct naming: the 2011 Washington game says Redskins, not Commanders.
  assert.ok(await page.getByText('Washington Redskins').isVisible(), 'era-correct team name');

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
  const patsRow = page.locator('tr', { hasText: 'New England Patriots' }).first();
  assert.equal(await patsRow.locator('td').nth(3).innerText(), '24', 'Patriots seen 24 times');

  // Delight extras: heatmap grid and companions leaderboard render now;
  // streaks/superlatives sections stay hidden until enrichment fills scores.
  assert.ok(await page.locator('.heat .cell.q1, .heat .cell.q2, .heat .cell.q3').count() > 20, 'heatmap has filled cells');
  assert.ok(await page.locator('h2.sec', { hasText: 'Crew' }).isVisible(), 'companions leaderboard present');
  const gundyRow = page.locator('tr', { hasText: 'Gundy' }).first();
  assert.equal(await gundyRow.locator('td').nth(1).innerText(), '1');
  assert.equal(await page.getByText('Superlatives').count(), 0, 'superlatives hidden pre-enrichment');
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
