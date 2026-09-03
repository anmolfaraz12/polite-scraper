const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { z } = require('zod');

const USER_AGENT = 'FlyRankInternshipA9/1.0 (+https://github.com/YOUR_USERNAME/YOUR_REPO)';
const TIMEOUT_MS = 8000;
const DELAY_MS = 500;
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MAX_CATALOGUE_PAGES = 3;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simple counters for the final run report
const stats = {
  pagesFetched: 0,
  cacheHits: 0,
  failedPages: 0,
};

/**
 * A fetch error that remembers the HTTP status, so callers can decide
 * whether it's worth retrying (5xx / timeout) or not (404 / 403).
 */
class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // null for network/timeout errors
  }
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (response.status !== 200) {
      throw new FetchError(`status ${response.status}`, response.status);
    }

    return await response.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new FetchError('request timed out', null);
    }
    if (err instanceof FetchError) throw err;
    throw new FetchError(err.message, null); // network-level error, e.g. DNS failure
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetches with cache, politeness delay, and ONE retry for timeouts/5xx.
 * Never retries 404 or 403 — those won't fix themselves.
 */
async function fetchWithCache(url, cacheFileName) {
  const cachePath = path.join(CACHE_DIR, cacheFileName);

  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, 'utf-8');
    console.log(`CACHE HIT — ${cacheFileName} (${html.length} bytes)`);
    stats.cacheHits++;
    return { html, fromCache: true };
  }

  console.log(`FETCH — ${url}`);

  let html;
  try {
    html = await fetchOnce(url);
  } catch (err) {
    const isRetryable = err.status === null || err.status >= 500;
    const isNoRetry = err.status === 404 || err.status === 403;

    if (isRetryable && !isNoRetry) {
      console.log(`  retrying once — ${err.message}`);
      await sleep(1000);
      html = await fetchOnce(url); // second and final attempt; let it throw if it fails again
    } else {
      throw err; // 404 / 403 — don't retry, just surface it
    }
  }

  fs.writeFileSync(cachePath, html, 'utf-8');
  console.log(`FETCH — saved ${cacheFileName} (${html.length} bytes)`);
  stats.pagesFetched++;

  return { html, fromCache: false };
}

function cacheNameForBookUrl(bookUrl) {
  const parts = bookUrl.split('/').filter(Boolean);
  const slug = parts[parts.length - 2];
  return `book-${slug}.html`;
}

async function discoverCataloguePages() {
  const bookEntries = new Map();
  let pageNumber = 1;
  let pageUrl = 'https://books.toscrape.com/catalogue/page-1.html';
  let pagesVisited = 0;

  while (pageUrl && pagesVisited < MAX_CATALOGUE_PAGES) {
    const cacheFileName = `catalogue-page-${pageNumber}.html`;
    const { html, fromCache } = await fetchWithCache(pageUrl, cacheFileName);
    pagesVisited++;

    if (!fromCache) await sleep(DELAY_MS);

    const $ = cheerio.load(html);
    $('h3 a').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        const absoluteUrl = new URL(href, pageUrl).toString();
        if (!bookEntries.has(absoluteUrl)) {
          bookEntries.set(absoluteUrl, pageUrl);
        }
      }
    });

    if (pagesVisited >= MAX_CATALOGUE_PAGES) break;

    const nextHref = $('.next a').attr('href');
    if (nextHref) {
      pageUrl = new URL(nextHref, pageUrl).toString();
      pageNumber++;
    } else {
      pageUrl = null;
    }
  }

  return bookEntries;
}

const RATING_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];

async function extractRawRecord(bookUrl, sourcePage) {
  const cacheFileName = cacheNameForBookUrl(bookUrl);
  const { html, fromCache } = await fetchWithCache(bookUrl, cacheFileName);

  if (!fromCache) await sleep(DELAY_MS);

  const $ = cheerio.load(html);
  const productArea = $('.product_page');

  const title = productArea.find('div.product_main h1').text().trim();
  const priceText = productArea.find('div.product_main p.price_color').text().trim();
  const availabilityText = productArea
    .find('div.product_main p.instock.availability')
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const ratingClass = productArea.find('div.product_main p.star-rating').attr('class') || '';
  const ratingWord = RATING_WORDS.find((word) => ratingClass.includes(word)) || null;

  const descriptionEl = productArea.find('#product_description').next('p');
  const description = descriptionEl.length ? descriptionEl.text().trim() : null;

  return {
    title,
    product_url: bookUrl,
    price_text: priceText,
    availability_text: availabilityText,
    rating_text: ratingWord,
    description,
    source_page: sourcePage,
    fetched_at: new Date().toISOString(),
  };
}

function parsePriceGbp(priceText) {
  const cleaned = priceText.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isNaN(value) ? null : value;
}

function normalizeRecord(raw) {
  return {
    title: raw.title,
    product_url: raw.product_url,
    price_text: raw.price_text,
    price_gbp: parsePriceGbp(raw.price_text),
    availability_text: raw.availability_text,
    rating_text: raw.rating_text,
    description: raw.description,
    source_page: raw.source_page,
    fetched_at: raw.fetched_at,
  };
}

const BookSchema = z.object({
  title: z.string().min(1),
  product_url: z.string().url(),
  price_text: z.string().min(1),
  price_gbp: z.number().positive(),
  availability_text: z.string().min(1),
  rating_text: z.string().nullable(),
  description: z.string().nullable(),
  source_page: z.string().url(),
  fetched_at: z.string().datetime(),
});

// TEMPORARY — proves one broken page can't take the run down.
// Remove this line (and the .set() below) once you've seen failed_pages: 1 in the report.
const INJECT_FAKE_URL_FOR_TESTING = false;

async function main() {
  const startTime = Date.now();
  const startedAtIso = new Date(startTime).toISOString();

  const bookEntries = await discoverCataloguePages();
  console.log(`discovered=${bookEntries.size} unique book URLs`);

  if (INJECT_FAKE_URL_FOR_TESTING) {
    const fakeUrl = 'https://books.toscrape.com/catalogue/this-book-does-not-exist_9999/index.html';
    bookEntries.set(fakeUrl, 'https://books.toscrape.com/catalogue/page-1.html');
    console.log('(testing) injected one fake book URL on purpose');
  }

  const validRecords = [];
  const invalidRecords = [];
  const seenUrls = new Set();

  for (const [bookUrl, sourcePage] of bookEntries) {
    if (seenUrls.has(bookUrl)) continue;
    seenUrls.add(bookUrl);

    try {
      const raw = await extractRawRecord(bookUrl, sourcePage);
      const normalized = normalizeRecord(raw);
      const result = BookSchema.safeParse(normalized);

      if (result.success) {
        validRecords.push(result.data);
      } else {
        invalidRecords.push({
          product_url: normalized.product_url,
          reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
    } catch (err) {
      // This page failed to fetch entirely — log it, count it, and move on.
      // The rest of the run must survive.
      console.log(`  FAILED — ${bookUrl} (${err.message})`);
      stats.failedPages++;
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'books.json'),
    JSON.stringify(validRecords, null, 2),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'errors.json'),
    JSON.stringify(invalidRecords, null, 2),
    'utf-8'
  );

  const endTime = Date.now();
  const runReport = {
    started_at: startedAtIso,
    duration_ms: endTime - startTime,
    pages_fetched: stats.pagesFetched,
    cache_hits: stats.cacheHits,
    valid_records: validRecords.length,
    invalid_records: invalidRecords.length,
    failed_pages: stats.failedPages,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'run-report.json'),
    JSON.stringify(runReport, null, 2),
    'utf-8'
  );

  console.log('\n--- Run report ---');
  console.log(JSON.stringify(runReport, null, 2));
}

main().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});