const fs = require('fs');
const path = require('path');

const USER_AGENT = 'FlyRankInternshipA9/1.0 (+https://github.com/anmolfaraz12/polite-scraper)';
const TIMEOUT_MS = 8000;
const CACHE_DIR = path.join(__dirname, '..', 'cache');

// Make sure the cache folder exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Fetches a URL politely, or reads it from cache if already saved.
 * @param {string} url - the page to fetch
 * @param {string} cacheFileName - e.g. "catalogue-page-1.html"
 * @returns {Promise<string>} the HTML content
 */
async function fetchWithCache(url, cacheFileName) {
  const cachePath = path.join(CACHE_DIR, cacheFileName);

  // If we already have this page cached, use it — no network call
  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, 'utf-8');
    console.log(`CACHE HIT — ${cacheFileName} (${html.length} bytes)`);
    return html;
  }

  // Otherwise, fetch it for real, politely
  console.log(`FETCH — ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status !== 200) {
    throw new Error(`Failed to fetch ${url} — status ${response.status}`);
  }

  const html = await response.text();
  fs.writeFileSync(cachePath, html, 'utf-8');
  console.log(`FETCH — saved ${cacheFileName} (${html.length} bytes)`);

  return html;
}

async function main() {
  const pageUrl = 'https://books.toscrape.com/catalogue/page-1.html';
  await fetchWithCache(pageUrl, 'catalogue-page-1.html');
}

main().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});