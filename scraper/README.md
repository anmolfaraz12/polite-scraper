# The Polite Scraper

A small, polite scraping pipeline that downloads the first three catalogue pages of
[Books to Scrape](https://books.toscrape.com), visits all 60 book pages, and turns the
messy HTML into clean, validated JSON records — without crashing on a broken page, and
with an honest report at the end of every run.

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

## Lane & setup

**Language:** Node.js 20+ (uses the built-in `fetch`)

```bash
cd scraper
npm install
```

## Run

```bash
node src/index.js
```

This single command:
1. Downloads (or reads from cache) the first 3 catalogue pages
2. Discovers all 60 unique book URLs
3. Fetches (or reads from cache) each of the 60 book detail pages
4. Extracts, normalizes, and validates each record
5. Writes `output/books.json`, `output/errors.json`, and `output/run-report.json`

Running it again produces the same 60 records — not 120 — because `product_url` is each
record's canonical identity and every run overwrites `books.json` fresh rather than
appending to it.

## Record schema

Each validated record in `output/books.json` has this shape:

| Field | Type | Notes |
|---|---|---|
| `title` | string | Book title |
| `product_url` | string (URL) | Canonical identity of the record |
| `price_text` | string | Raw price as shown on the page, e.g. `"£51.77"` |
| `price_gbp` | number | Parsed price, e.g. `51.77` — kept alongside the raw text |
| `availability_text` | string | Raw stock text, e.g. `"In stock (22 available)"` |
| `rating_text` | string \| null | Star rating word, e.g. `"Three"` |
| `description` | string \| null | `null` when the book has no description — never invented |
| `source_page` | string (URL) | Which catalogue page this book was discovered on |
| `fetched_at` | string (ISO datetime) | When this record was fetched |

Records are validated against this schema (built with [Zod](https://zod.dev)) before
being stored. Any record that fails validation is written to `output/errors.json`
instead, together with the reason — it never reaches `books.json`.

## Politeness rules followed

- An identifying `User-Agent` header on every real request (`FlyRankInternshipA9/1.0`,
  with a link back to this repo)
- An 8-second timeout — a request never waits forever
- The status code is checked before any parsing; only `200` is treated as success
- At least 500ms delay between real requests to the site — never after a cache hit
- A local cache (`cache/`) is used during development, so the site is only ever hit once
  per page, no matter how many times the script is re-run while building it
- One retry (after a short wait) for timeouts and `5xx` server errors; **no** retry for
  `404` or `403` — those won't fix themselves, and retrying a `403` is how a polite robot
  becomes a pest

## Surviving failures

Each page is fetched and processed independently. If one page fails (network error,
timeout, or a non-200 status even after a retry), it is logged and counted — the rest of
the run continues. This was verified by deliberately injecting one fake, non-existent
book URL into the run: `books.json` still ended up with all 60 good records, and
`run-report.json` reported `failed_pages: 1`.

## Sample run report

A real `output/run-report.json` from a clean run (fully cached, no injected failures):

```json
{
  "started_at": "2026-09-03T11:50:57.447Z",
  "duration_ms": 614,
  "pages_fetched": 0,
  "cache_hits": 63,
  "valid_records": 60,
  "invalid_records": 0,
  "failed_pages": 0
}
```

## Why no browser was needed

Every field this scraper collects — title, price, availability, rating, description — is
already present in the plain HTML the server sends back. There is no JavaScript-rendered
content to wait for, so a headless browser would only add cost (memory, startup time)
without unlocking any data a plain HTTP request couldn't already see.

## Output files

- `output/books.json` — the 60 validated, unique records
- `output/errors.json` — any records that failed schema validation, with a reason
- `output/run-report.json` — start time, duration, pages fetched, cache hits, valid/
  invalid record counts, and failed pages for the most recent run

## A known limitation

This scraper assumes Books to Scrape's HTML structure (class names like `.price_color`,
`.star-rating`, `#product_description`) stays stable. If the site redesigns its markup,
the selectors in `src/index.js` would need to be updated — there is no automatic
detection of a broken selector versus a genuinely missing field.

## Ethics note

This scraper only touches a site built and explicitly offered for scraping practice.
More generally: prefer an official API when one exists over scraping; never bypass
logins, paywalls, CAPTCHAs, or explicit blocks; collect only the data actually needed for
the task; and always identify yourself honestly via the `User-Agent` header so a site
owner can see who is visiting and why.