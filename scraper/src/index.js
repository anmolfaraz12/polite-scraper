const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const USER_AGENT = 'FlyRankInternshipA9/1.0 (+https://github.com/anmolfaraz12/polite-scraper)';
const TIMEOUT_MS = 8000;
const DELAY_MS = 500;
const CACHE_DIR = path.join(__dirname, '..', 'cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a URL politely, or reads it from cache if already saved.
 * Returns { html, fromCache } so callers know whether a real request happened.
 */
async function fetchWithCache(url, cacheFileName) {
  const cachePath = path.join(CACHE_DIR, cacheFileName);

  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, 'utf-8');
    console.log(`CACHE HIT — ${cacheFileName} (${html.length} bytes)`);
    return { html, fromCache: true };
  }

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

  return { html, fromCache: false };
}

/**
 * Discovers all catalogue pages (following "next" links) and collects
 * every unique, absolute book URL found across them.
 */
const MAX_CATALOGUE_PAGES = 3; // assignment scope: only the first 3 pages

async function discoverCataloguePages() {
  const bookUrls = new Set();
  let pageNumber = 1;
  let pageUrl = 'https://books.toscrape.com/catalogue/page-1.html';
  let pagesVisited = 0;

  while (pageUrl && pagesVisited < MAX_CATALOGUE_PAGES) {
    const cacheFileName = `catalogue-page-${pageNumber}.html`;
    const { html, fromCache } = await fetchWithCache(pageUrl, cacheFileName);
    pagesVisited++;

    // Only delay after a REAL request, never after a cache hit
    if (!fromCache) {
      await sleep(DELAY_MS);
    }

    const $ = cheerio.load(html);

    // Collect every book link on this page, convert relative -> absolute
    $('h3 a').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        const absoluteUrl = new URL(href, pageUrl).toString();
        bookUrls.add(absoluteUrl);
      }
    });

    // Stop once we've reached the page limit — don't even look for "next"
    if (pagesVisited >= MAX_CATALOGUE_PAGES) {
      break;
    }

    // Find the "next" link, if any, and turn it into an absolute URL too
    const nextHref = $('.next a').attr('href');
    if (nextHref) {
      pageUrl = new URL(nextHref, pageUrl).toString();
      pageNumber++;
    } else {
      pageUrl = null; // no more pages, stop the loop
    }
  }

  return { bookUrls: Array.from(bookUrls), pagesVisited };
}

async function main() {
  const { bookUrls, pagesVisited } = await discoverCataloguePages();

  console.log(`catalogue_pages=${pagesVisited}`);
  console.log(`discovered=${bookUrls.length}`);
  console.log(`unique_urls=${bookUrls.length}`);
}

main().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});