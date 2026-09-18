# ESMA

Local prototype that copies Endstep’s metagame matchup numbers into a table you can open on localhost. It refreshes once a day while the Node server is running.

Endstep’s own Meta pages live at `https://endstep.cc/metagame`. Ranked formats currently expose public JSON at `/api/metagame/v1`. This project reads that data (through Chrome via Selenium by default) and stores a snapshot in `data/latest.json`.

## What you get

- Python scraper: the top 20 Pauper decks, then each deck’s win rate against the other 19
- Node site on `http://127.0.0.1:3456` with a color-coded matchup matrix
- Automatic scrape if the snapshot is older than 24 hours (checked hourly)
- A **Refresh now** button on the page

## Setup

Python 3.12+ (`py -3`), Node.js, and Chrome (for the Selenium path).

```powershell
cd C:\Users\C305657\ESMA
py -3 -m pip install -r requirements.txt
```

## First scrape

Defaults are Pauper, top 20 decks, 30-day rated window.

Selenium (default; uses a real Chrome session, which is more likely to get past Cloudflare):

```powershell
py -3 scrape.py
```

HTTP fallback if Chrome is not available:

```powershell
py -3 scrape.py --backend http
```

A full run takes a couple of minutes because it walks all 20 decks’ matchup lists. Shrink it while testing:

```powershell
py -3 scrape.py --backend http --top-decks 8
```

## View the table

```powershell
npm start
```

Then open [http://127.0.0.1:3456](http://127.0.0.1:3456).

Optional environment variables for scrapes started from the site:

| Variable | Meaning |
| --- | --- |
| `SCRAPE_BACKEND` | `selenium` (default) or `http` |
| `SCRAPE_WINDOW` | e.g. `7d`, `30d` |
| `SCRAPE_POPULATION` | `rated` or `all` |
| `SCRAPE_TOP_DECKS` | how many decks, default `20` |
| `SCRAPE_FORMATS` | comma-separated ids, default `Pauper` |
| `PORT` | server port, default `3456` |

Example:

```powershell
$env:SCRAPE_BACKEND = "http"
npm start
```

Daily updates happen only while `npm start` is running. Keep that window open, or register a Windows scheduled task that runs `py -3 scrape.py` once a day.

## Notes

- This is a personal prototype. Do not hammer Endstep; the scraper already pauses between requests.
- Cells show the **row** deck’s win rate against the **column** deck. Empty cells mean that pairing did not meet Endstep’s sample threshold in the selected window.
- The diagonal is left blank (same deck).
