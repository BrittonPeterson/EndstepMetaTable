"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3456);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_PATH = path.join(ROOT, "data", "latest.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 60;

const STATIC_PAGES = {
  "/": {
    body: fs.readFileSync(path.join(PUBLIC_DIR, "index.html")),
    type: "text/html; charset=utf-8",
  },
  "/index.html": {
    body: fs.readFileSync(path.join(PUBLIC_DIR, "index.html")),
    type: "text/html; charset=utf-8",
  },
  "/styles.css": {
    body: fs.readFileSync(path.join(PUBLIC_DIR, "styles.css")),
    type: "text/css; charset=utf-8",
  },
  "/app.js": {
    body: fs.readFileSync(path.join(PUBLIC_DIR, "app.js")),
    type: "text/javascript; charset=utf-8",
  },
};

let scrapeInFlight = null;
const hits = [];

function allowedByRateLimit() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) {
    hits.shift();
  }
  if (hits.length >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }
  hits.push(now);
  return true;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

let cachedMeta = null;
let cachedMtime = 0;

function reloadCache() {
  try {
    cachedMeta = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    cachedMeta = null;
  }
  return cachedMeta;
}

// A scrape started outside this process still updates the file, so the cache
// follows the file's mtime rather than only reloading after our own scrapes.
function readLatest() {
  let mtime = 0;
  try {
    mtime = fs.statSync(DATA_PATH).mtimeMs;
  } catch {
    cachedMeta = null;
    cachedMtime = 0;
    return null;
  }
  if (mtime !== cachedMtime) {
    cachedMtime = mtime;
    reloadCache();
  }
  return cachedMeta;
}

function runScrape() {
  if (scrapeInFlight) {
    return scrapeInFlight;
  }

  const backend = process.env.SCRAPE_BACKEND === "http" ? "http" : "selenium";
  const args = [path.join(ROOT, "scrape.py"), "--backend", backend];
  const window = process.env.SCRAPE_WINDOW;
  const population = process.env.SCRAPE_POPULATION;
  const topDecks = process.env.SCRAPE_TOP_DECKS;
  const formats = process.env.SCRAPE_FORMATS;
  if (window && /^[0-9]+d$/.test(window)) {
    args.push("--window", window);
  }
  if (population === "rated" || population === "all") {
    args.push("--population", population);
  }
  if (topDecks && /^[0-9]{1,3}$/.test(topDecks)) {
    args.push("--top-decks", topDecks);
  }
  if (formats && /^[A-Za-z0-9,_-]+$/.test(formats)) {
    args.push("--formats", formats);
  }

  scrapeInFlight = new Promise((resolve, reject) => {
    const child = spawn("py", ["-3", ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      scrapeInFlight = null;
      reject(err);
    });
    child.on("close", (code) => {
      scrapeInFlight = null;
      if (code === 0) {
        reloadCache();
        resolve({ ok: true });
      } else {
        reject(new Error(stderr.trim() || `scraper exited with code ${code}`));
      }
    });
  });

  return scrapeInFlight;
}

function maybeDailyScrape() {
  const latest = (() => {
    try {
      return readLatest();
    } catch {
      return null;
    }
  })();
  const scrapedAt = latest && Date.parse(latest.scrapedAt);
  const stale = !Number.isFinite(scrapedAt) || Date.now() - scrapedAt > DAY_MS;
  if (stale) {
    runScrape().catch((err) => {
      console.error("Scheduled scrape failed:", err.message);
    });
  }
}

function serveStatic(res, pathname) {
  if (pathname === "/styles.css") {
    send(res, 200, STATIC_PAGES["/styles.css"].body, {
      "Content-Type": STATIC_PAGES["/styles.css"].type,
    });
    return;
  }
  if (pathname === "/app.js") {
    send(res, 200, STATIC_PAGES["/app.js"].body, {
      "Content-Type": STATIC_PAGES["/app.js"].type,
    });
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    send(res, 200, STATIC_PAGES["/"].body, {
      "Content-Type": STATIC_PAGES["/"].type,
    });
    return;
  }
  send(res, 404, "Not found");
}

const server = http.createServer((req, res) => {
  if (!allowedByRateLimit()) {
    sendJson(res, 429, { error: "Too many requests" });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    send(res, 400, "Bad request");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    try {
      const latest = readLatest();
      if (!latest) {
        sendJson(res, 404, {
          error: "No snapshot yet. Run the scraper or press Refresh.",
        });
        return;
      }
      sendJson(res, 200, latest);
    } catch (err) {
      sendJson(res, 500, { error: "Failed to read snapshot" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/refresh") {
    runScrape()
      .then(() => sendJson(res, 200, { ok: true, data: readLatest() }))
      .catch(() => sendJson(res, 500, { error: "Refresh failed" }));
    return;
  }

  if (req.method === "GET") {
    serveStatic(res, url.pathname);
    return;
  }

  send(res, 405, "Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`ESMA table: http://${HOST}:${PORT}`);
  maybeDailyScrape();
  setInterval(maybeDailyScrape, 60 * 60 * 1000);
});
