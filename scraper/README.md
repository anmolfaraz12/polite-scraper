# The Polite Scraper 

A small, polite scraping pipeline that downloads the first three catalogue pages of
[Books to Scrape](https://books.toscrape.com), visits all 60 book pages, and turns the
messy HTML into clean, validated JSON records.

## Target classification

- **Target site:** [books.toscrape.com](https://books.toscrape.com)
- **Why this site:** Its parent site, [toscrape.com](https://toscrape.com), explicitly
  describes it as a *"fictional bookstore that desperately wants to be scraped"* — built
  specifically as a safe practice sandbox for people learning web scraping.
- **Scope:** Only the first 3 catalogue pages (60 books total). No other pages, no other
  sites.
- **Data collected:** Title, product URL, price, availability, star rating, description,
  source page, and fetch timestamp — all publicly visible text already present in the
  page's HTML.
- **robots.txt result:** Requested `https://books.toscrape.com/robots.txt` — the request
  returned a **404 (not found)**. No robots file exists for this site. A missing file is
  not permission by itself, but combined with the site's own statement that it exists to
  be scraped, proceeding here is appropriate.

**I will not reuse this code on another site without checking its rules and terms first.**

## Setup

```bash
cd scraper
npm install
```

## Run

```bash
node src/index.js
```

## Politeness rules followed

- Identifying `User-Agent` header on every real request
- Request timeout (never waits forever)
- Status code checked before parsing
- At least 500ms delay between real requests
- Local cache (`cache/`) used during development so the site is only hit once per page

## Output

- `output/books.json` — validated records
- `output/run-report.json` — honest summary of each run