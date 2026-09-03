const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const USER_AGENT = 'FlyRankInternshipA9/1.0 (+https://github.com/YOUR_USERNAME/YOUR_REPO)';
const TIMEOUT_MS = 8000;
const DELAY_MS = 500;
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MAX_CATALOGUE_PAGES = 3; // assignment scope: only the first 3 pages

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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

/**
 * Turns a book detail page's URL into a safe cache file name,
 * e.g. ".../a-light-in-the-attic_1000/index.html" -> "book-a-light-in-the-attic_1000.html"
 */
function cacheNameForBookUrl(bookUrl) {
  const parts = bookUrl.split('/').filter(Boolean);
  const slug = parts[parts.length - 2]; // the folder name before index.html
  return `book-${slug}.html`;
}

/**
 * Discovers the first MAX_CATALOGUE_PAGES catalogue pages and collects
 * every unique, absolute book URL found across them, remembering which
 * catalogue page each book came from (source_page).
 */
async function discoverCataloguePages() {
  const bookEntries = new Map(); // url -> sourcePage
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

    if (pagesVisited >= MAX_CATALOGUE_PAGES) {
      break;
    }

    const nextHref = $('.next a').attr('href');
    if (nextHref) {
      pageUrl = new URL(nextHref, pageUrl).toString();
      pageNumber++;
    } else {
      pageUrl = null;
    }
  }

  return bookEntries; // Map<bookUrl, sourcePage>
}

// Maps a star-rating class like "star-rating Three" to the word "Three"
const RATING_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];

/**
 * Fetches one book detail page and extracts the 8 raw fields.
 */
async function extractBookRecord(bookUrl, sourcePage) {
  const cacheFileName = cacheNameForBookUrl(bookUrl);
  const { html, fromCache } = await fetchWithCache(bookUrl, cacheFileName);

  if (!fromCache) {
    await sleep(DELAY_MS);
  }

  const $ = cheerio.load(html);
  const productArea = $('.product_page'); // scope selectors to the product area

  const title = productArea.find('div.product_main h1').text().trim();

  const priceText = productArea.find('div.product_main p.price_color').text().trim();

  const availabilityText = productArea
    .find('div.product_main p.instock.availability')
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const ratingClass = productArea.find('div.product_main p.star-rating').attr('class') || '';
  const ratingWord = RATING_WORDS.find((word) => ratingClass.includes(word)) || null;

  // Description sits in a <p> right after #product_description; some books have none
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

async function main() {
  const bookEntries = await discoverCataloguePages();
  console.log(`discovered=${bookEntries.size} unique book URLs`);

  const records = [];
  for (const [bookUrl, sourcePage] of bookEntries) {
    const record = await extractBookRecord(bookUrl, sourcePage);
    records.push(record);
  }

  console.log('\n--- Sample record ---');
  console.log(JSON.stringify(records[0], null, 2));

  console.log(`\ndetail_pages=${records.length}`);
}

main().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});