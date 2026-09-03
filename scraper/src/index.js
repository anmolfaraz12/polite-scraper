const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { z } = require('zod');

const USER_AGENT = 'FlyRankInternshipA9/1.0 (+https://github.com/YOUR_USERNAME/YOUR_REPO)';
const TIMEOUT_MS = 8000;
const DELAY_MS = 500;
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MAX_CATALOGUE_PAGES = 3; // assignment scope: only the first 3 pages

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a URL politely, or reads it from cache if already saved.
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

function cacheNameForBookUrl(bookUrl) {
  const parts = bookUrl.split('/').filter(Boolean);
  const slug = parts[parts.length - 2];
  return `book-${slug}.html`;
}

/**
 * Discovers the first MAX_CATALOGUE_PAGES catalogue pages and collects
 * every unique, absolute book URL found across them (with source_page).
 */
async function discoverCataloguePages() {
  const bookEntries = new Map(); // url -> sourcePage (Map keys are naturally unique -> no duplicates)
  let pageNumber = 1;
  let pageUrl = 'https://books.toscrape.com/catalogue/page-1.html';
  let pagesVisited = 0;

  while (pageUrl && pagesVisited < MAX_CATALOGUE_PAGES) {
    const cacheFileName = `catalogue-page-${pageNumber}.html`;
    const { html, fromCache } = await fetchWithCache(pageUrl, cacheFileName);
    pagesVisited++;

    if (!fromCache) {
      await sleep(DELAY_MS);
    }

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

/**
 * Fetches one book detail page and extracts the 8 raw fields.
 */
async function extractRawRecord(bookUrl, sourcePage) {
  const cacheFileName = cacheNameForBookUrl(bookUrl);
  const { html, fromCache } = await fetchWithCache(bookUrl, cacheFileName);

  if (!fromCache) {
    await sleep(DELAY_MS);
  }

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

/**
 * Turns "£51.77" into 51.77. Keeps the raw text separately in the caller.
 */
function parsePriceGbp(priceText) {
  const cleaned = priceText.replace(/[^0-9.]/g, ''); // strip £ and any stray chars
  const value = parseFloat(cleaned);
  return Number.isNaN(value) ? null : value;
}

/**
 * Normalizes a raw record into the clean shape ready for validation.
 */
function normalizeRecord(raw) {
  return {
    title: raw.title,
    product_url: raw.product_url, // canonical identity for the record
    price_text: raw.price_text,
    price_gbp: parsePriceGbp(raw.price_text),
    availability_text: raw.availability_text,
    rating_text: raw.rating_text,
    description: raw.description,
    source_page: raw.source_page,
    fetched_at: raw.fetched_at,
  };
}

// The schema: the recipe for a valid, finished record
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

async function main() {
  const bookEntries = await discoverCataloguePages();
  console.log(`discovered=${bookEntries.size} unique book URLs`);

  const validRecords = [];
  const invalidRecords = [];

  // product_url is the canonical identity — using it as a Map key means
  // re-running never produces two records for the same book (idempotent).
  const seenUrls = new Set();

  for (const [bookUrl, sourcePage] of bookEntries) {
    if (seenUrls.has(bookUrl)) continue; // guard against accidental duplicates
    seenUrls.add(bookUrl);

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

  console.log(`\nvalid_records=${validRecords.length}`);
  console.log(`invalid_records=${invalidRecords.length}`);
  console.log('Wrote output/books.json and output/errors.json');
}

main().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});