# Stub Book 🎟️

A personal record of every pro game I've been to — the stubs, the stats, and the
stadiums. One self-contained static page, no backend, no build dependencies:
the whole site is `index.html`, generated from JSON records that live in this
repo. Box scores deep-link to the
[Sports-Reference](https://www.sports-reference.com/) family
(Baseball-Reference, Pro-Football-Reference, Hockey-Reference,
Basketball-Reference).

## View it

Open `index.html` in any browser, or serve the repo root (GitHub Pages works
as-is: Settings → Pages → deploy from branch, root folder).

Three views, hash-routed so they're linkable:

- **`#/timeline`** — every game, newest first, with era-correct team names
  ("Washington Redskins" on a 2011 card), scores and winner once enriched,
  venue, personal notes, and a box-score link. Fuzzy dates render dashed as
  `~2003`; fully undated games get their own section. Filter by league or team.
- **`#/records`** — games per league, per-team seen counts (home/away/total)
  and each team's W–L record in games I attended, the most-seen matchup, a
  year-by-month **calendar heatmap**, and a **Crew** leaderboard of who I've
  gone with (fed by each record's `companions` list). Once box scores are
  enriched, two more sections light up automatically: **Superlatives**
  (biggest crowd, longest game, hottest/coldest, biggest blowout, extra-time
  count) and **longest win streaks while I was there**.
- **`#/venues`** — per-league venue table with visit counts and years,
  completion bars against each league's active venues, and the buildings I've
  seen games in that no longer host.

## Data model

One JSON file per game in `data/games/` — that's the source of truth. Hand-edit
freely; `node tools/validate.js` checks everything against
`tools/lib/schema.js` and the reference tables:

- `data/reference/teams.json` — franchise registry with **era-aware** display
  names, Sports-Reference codes (which differ from official abbreviations and
  change on relocation years: `NJN`→`BRK`, `OAK`→`ATH`, PFR's `nwe`/`oti`),
  and API identifiers.
- `data/reference/venues.json` — venues incl. defunct ones, with home-team
  eras so a game's building can be inferred before its box score is fetched.

Fuzzy history is first-class: `datePrecision` is `day`, `year` (`"2003?"` in
the old spreadsheet), or `unknown`; `away: null` means the opponent is
forgotten. Such games still count where they can (attendance tallies, venues)
and are excluded where they can't (W–L, box-score links).

Neutral sites (Super Bowl, London, All-Star) set `neutralSite: true` plus a
`venueOverride`, so "home team" stays a designation, not a location.

## Adding a game

1. Copy any file in `data/games/`, rename to `{league}-{YYYY-MM-DD}-{away}-{home}.json`,
   edit the fields (team codes are the keys in `teams.json`), leave
   `enrichment.status: "pending"`.
2. `node tools/enrich.js` (see below) to pull the box score, or don't — the
   site renders fine without it.
3. `node tools/build.js` and commit the record, snapshot, and `index.html`.

## Enrichment — run this on your own machine

The CLI is zero-dependency — a fresh clone and Node ≥ 18 is all it needs, no
`npm install` required.

`tools/enrich.js` resolves each pending game against free league APIs
(MLB Stats API, NHL api-web, ESPN for NFL/NBA), saves the raw response under
`data/snapshots/`, and writes a normalized summary (score, linescore, venue,
attendance, weather, duration) back into the game record. Snapshots are
**fetched once and committed** — the site builds only from them, so API churn
can't break anything retroactively.

```sh
node tools/enrich.js                 # everything pending with an exact date
node tools/enrich.js --game <id>     # one game
node tools/enrich.js --dry-run       # resolve and print, write nothing
node tools/enrich.js --search <id>   # fuzzy "2003?" dates: list that season's
                                     #   candidate games (with day-of-week)
node tools/enrich.js --pick <id> <sourceGameId>   # commit a candidate
node tools/enrich.js --force <id>    # refetch + overwrite a snapshot
node tools/enrich.js --renormalize   # recompute summaries from committed
                                     #   snapshots — offline, run after any
                                     #   normalizer improvement, no refetching
node tools/enrich.js --weather-nfl   # fill NFL weather (temp/wind/dome) from
                                     #   the nflverse games.csv dataset
```

It sleeps ≥1s between requests and is idempotent. Corporate/CI proxies often
block the sports APIs (that's a "run me locally" error, not a bug). If the API
disagrees with a record's home/away teams it warns and asks for
`--accept-swap`. If a value is simply wrong (old NHL attendance, say), set it
in the record's `overrides` — overrides always win over enrichment.

The original spreadsheet import lives in `tools/import-sheet.js` with the
transcribed sheet at `data/import/sheet.csv`;
`node tools/import-sheet.js --reconcile` re-checks the derived per-team counts
against the sheet's hand-kept tally (they match exactly).

## Development

`src/template.html` is the real site — CSS plus three script blocks:
`#stats` (derivations: seasons, eras, W–L, venues) and `#links`
(Sports-Reference URL construction) are DOM-free and unit-tested under Node
by extraction; `#ui` renders. `tools/build.js` validates all records and bakes
`{games, teams, venues}` into the `__DATA_JSON__` placeholder,
deterministically — a test byte-compares the committed `index.html` against a
fresh build, so rebuild before committing data changes.

```sh
npm install    # playwright-core only (tests)
npm test       # Node suites, then a headless-Chromium UI smoke test
npm run test:node   # skip the browser test
```

The browser tests use, in order: `$CHROMIUM` / `/opt/pw-browsers/chromium`
when present, playwright's own registry Chromium, then an installed Google
Chrome. Without `npm install` they skip with a note instead of failing. Screenshots land in `test/out/`. No test ever
touches the network — enrichment normalizers are tested against recorded
fixtures in `test/fixtures/`.

## Roadmap

- **Stretch**: per-player stats accumulated only in games I attended, a venue
  map, milestone tags for moments witnessed (a free-form `tags: []` field
  already renders as badges), stub photo support (`images: []` per game is an
  easy schema add).
