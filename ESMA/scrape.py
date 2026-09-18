#!/usr/bin/env python3
"""Pull Endstep deck-vs-deck win rates and write data/latest.json."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
OUTPUT_PATH = DATA_DIR / "latest.json"
ORIGIN = "https://endstep.cc"
API_PREFIX = "/api/metagame/v1"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_query(**params: Any) -> str:
    items = []
    for key, value in params.items():
        if value is None or value == "":
            continue
        items.append((key, str(value)))
    return urllib.parse.urlencode(items)


class Client:
    def get(self, path: str) -> Any:
        raise NotImplementedError

    def close(self) -> None:
        return None


class HttpClient(Client):
    def get(self, path: str) -> Any:
        url = ORIGIN + path
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = resp.read().decode("utf-8")
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status} for {path}: {body[:300]}")
                return json.loads(body)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code} for {path}: {body[:300]}") from exc


class SeleniumClient(Client):
    def __init__(self) -> None:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        options = Options()
        options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--no-sandbox")
        options.add_argument("--window-size=1400,900")
        options.add_argument(f"--user-agent={USER_AGENT}")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)

        self.driver = webdriver.Chrome(options=options)
        self.driver.set_page_load_timeout(60)
        self.driver.get(f"{ORIGIN}/metagame")
        WebDriverWait(self.driver, 40).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        time.sleep(2)

    def get(self, path: str) -> Any:
        result = self.driver.execute_async_script(
            """
            const path = arguments[0];
            const done = arguments[arguments.length - 1];
            fetch(path, {
              credentials: "include",
              headers: { Accept: "application/json" }
            })
              .then((r) => r.text().then((t) => done({
                ok: r.ok,
                status: r.status,
                body: t
              })))
              .catch((err) => done({
                ok: false,
                status: 0,
                body: String(err)
              }));
            """,
            path,
        )
        if not result or not result.get("ok"):
            status = (result or {}).get("status")
            body = (result or {}).get("body", "")[:300]
            raise RuntimeError(f"Browser fetch failed ({status}) for {path}: {body}")
        return json.loads(result["body"])

    def close(self) -> None:
        try:
            self.driver.quit()
        except Exception:
            pass


def paginate(client: Client, path: str, collection: str, page_size: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    total = None
    while True:
        sep = "&" if "?" in path else "?"
        payload = client.get(f"{path}{sep}page={page}&pageSize={page_size}")
        bucket = payload.get(collection) or {}
        chunk = bucket.get("items") or []
        items.extend(chunk)
        total = bucket.get("total", len(items))
        if not chunk or len(items) >= total:
            return items
        page += 1
        time.sleep(0.25)


def scrape_format(
    client: Client,
    format_id: str,
    window: str,
    population: str,
    top_decks: int,
    delay: float,
) -> dict[str, Any]:
    query = build_query(window=window, population=population, sort="share", dir="desc")
    decks_path = f"{API_PREFIX}/{urllib.parse.quote(format_id)}/decks?{query}"
    first = client.get(f"{decks_path}&page=1&pageSize={min(50, top_decks)}")
    decks = list((first.get("decks") or {}).get("items") or [])
    total_decks = (first.get("decks") or {}).get("total", len(decks))
    while len(decks) < min(top_decks, total_decks):
        page = (len(decks) // 50) + 1
        more = client.get(f"{decks_path}&page={page}&pageSize=50")
        chunk = (more.get("decks") or {}).get("items") or []
        if not chunk:
            break
        decks.extend(chunk)
        time.sleep(delay)

    decks = decks[:top_decks]
    slugs = {deck["slug"] for deck in decks}
    matchups: list[dict[str, Any]] = []

    for index, deck in enumerate(decks, start=1):
        slug = deck["slug"]
        print(f"  [{format_id}] {index}/{len(decks)} matchups for {deck['name']}", flush=True)
        match_query = build_query(
            window=window,
            population=population,
            sort="matches",
            dir="desc",
        )
        path = (
            f"{API_PREFIX}/{urllib.parse.quote(format_id)}"
            f"/decks/{urllib.parse.quote(slug)}/matchups?{match_query}"
        )
        rows = paginate(client, path, "matchups", page_size=50)
        for row in rows:
            opponent = row.get("opponent") or {}
            opp_slug = opponent.get("slug")
            if opp_slug not in slugs:
                continue
            matchups.append(
                {
                    "deckSlug": slug,
                    "deckName": deck["name"],
                    "opponentSlug": opp_slug,
                    "opponentName": opponent.get("name"),
                    "wins": row.get("wins"),
                    "losses": row.get("losses"),
                    "matches": row.get("matches"),
                    "rate": row.get("rate"),
                    "low": row.get("low"),
                    "high": row.get("high"),
                }
            )
        time.sleep(delay)

    return {
        "formatId": format_id,
        "provenance": first.get("provenance"),
        "totals": first.get("totals"),
        "decks": [
            {
                "id": deck.get("id"),
                "slug": deck.get("slug"),
                "name": deck.get("name"),
                "colours": deck.get("colours") or [],
                "keyCards": deck.get("keyCards") or [],
                "share": (deck.get("share") or {}).get("rate"),
                "registrations": (deck.get("share") or {}).get("registrations"),
                "players": deck.get("players"),
                "winRate": (deck.get("matchWinRate") or {}).get("rate"),
                "wins": (deck.get("matchWinRate") or {}).get("wins"),
                "losses": (deck.get("matchWinRate") or {}).get("losses"),
            }
            for deck in decks
        ],
        "matchups": matchups,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape Endstep metagame matchups.")
    parser.add_argument("--backend", choices=["selenium", "http"], default="selenium")
    parser.add_argument("--window", default="30d", help="Endstep window preset, e.g. 7d or 30d")
    parser.add_argument("--population", default="rated", help="rated or all")
    parser.add_argument("--top-decks", type=int, default=20)
    parser.add_argument("--formats", default="Pauper", help="Comma-separated format ids.")
    parser.add_argument("--delay", type=float, default=0.35, help="Pause between requests, in seconds")
    args = parser.parse_args()

    client: Client
    if args.backend == "selenium":
        print("Starting Chrome via Selenium…", flush=True)
        client = SeleniumClient()
    else:
        client = HttpClient()

    try:
        visibility = client.get(f"{API_PREFIX}/visibility")
        formats_payload = client.get(f"{API_PREFIX}/formats")
        available = [item["formatId"] for item in formats_payload.get("formats") or []]
        selected = [part.strip() for part in args.formats.split(",") if part.strip()]

        snapshot: dict[str, Any] = {
            "scrapedAt": utc_now(),
            "source": ORIGIN,
            "backend": args.backend,
            "window": args.window,
            "population": args.population,
            "topDecks": args.top_decks,
            "visibility": visibility,
            "formats": {},
        }

        for format_id in selected:
            if format_id not in available:
                print(f"Skipping unknown format {format_id}", flush=True)
                continue
            print(f"Scraping {format_id}…", flush=True)
            snapshot["formats"][format_id] = scrape_format(
                client,
                format_id,
                args.window,
                args.population,
                args.top_decks,
                args.delay,
            )

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        print(f"Wrote {OUTPUT_PATH}", flush=True)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        raise SystemExit(130)
