'use strict';

// Browser plumbing shared by the UI tests. Keeps a fresh clone friendly:
// missing playwright-core skips (with instructions) instead of stack-tracing,
// and the launch falls back to an installed Google Chrome on machines that
// have neither the pinned Chromium nor a playwright registry download.

const fs = require('fs');

// Returns the playwright-core chromium object, or null (after printing why)
// when the devDependency isn't installed.
function requireChromium(testName) {
  try {
    return require('playwright-core').chromium;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    console.log(`${testName}: SKIPPED — playwright-core not installed. ` +
      'Run `npm install` for the browser tests, or `npm run test:node` to skip them.');
    return null;
  }
}

async function launchBrowser(chromium) {
  const pinned = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
  if (fs.existsSync(pinned)) return chromium.launch({ executablePath: pinned });
  try {
    return await chromium.launch(); // playwright registry install (CI)
  } catch (err) {
    return chromium.launch({ channel: 'chrome' }); // system Google Chrome (macOS/Windows)
  }
}

module.exports = { requireChromium, launchBrowser };
