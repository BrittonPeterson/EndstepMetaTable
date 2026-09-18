const statusEl = document.getElementById("status");
const formatsEl = document.getElementById("formats");
const wrapEl = document.getElementById("table-wrap");
const refreshBtn = document.getElementById("refresh");

let snapshot = null;
let currentFormat = null;

function pct(value) {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function cellColor(rate) {
  if (rate == null) {
    return "transparent";
  }
  const t = Math.max(0, Math.min(1, (rate - 0.35) / 0.3));
  const lose = [138, 59, 50];
  const mid = [74, 69, 60];
  const win = [63, 122, 78];
  const from = t < 0.5 ? lose : mid;
  const to = t < 0.5 ? mid : win;
  const local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const mix = from.map((channel, i) => Math.round(channel + (to[i] - channel) * local));
  return `rgb(${mix.join(",")})`;
}

function formatTimestamp(value) {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  return date.toLocaleString();
}

function renderFormats() {
  formatsEl.replaceChildren();
  const names = Object.keys(snapshot.formats || {});
  if (!currentFormat || !snapshot.formats[currentFormat]) {
    currentFormat = names[0] || null;
  }
  for (const name of names) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    if (name === currentFormat) {
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => {
      currentFormat = name;
      render();
    });
    formatsEl.appendChild(button);
  }
}

function renderTable() {
  const pack = snapshot.formats[currentFormat];
  if (!pack) {
    wrapEl.replaceChildren(emptyMessage("No format data in this snapshot."));
    return;
  }

  const decks = pack.decks || [];
  const lookup = new Map();
  for (const row of pack.matchups || []) {
    lookup.set(`${row.deckSlug}::${row.opponentSlug}`, row);
  }

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "corner";
  corner.textContent = `${pack.formatId} \\ opp`;
  headRow.appendChild(corner);
  for (const deck of decks) {
    const th = document.createElement("th");
    th.textContent = deck.name;
    th.title = `${pct(deck.share)} share · ${pct(deck.winRate)} overall`;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  for (const deck of decks) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.className = "rowhead";
    rowHead.textContent = "";
    rowHead.append(deck.name);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${pct(deck.share)} share · ${pct(deck.winRate)} WR`;
    rowHead.append(meta);
    tr.appendChild(rowHead);

    for (const opponent of decks) {
      const td = document.createElement("td");
      if (deck.slug === opponent.slug) {
        td.textContent = "—";
        td.title = "Same deck";
      } else {
        const cell = lookup.get(`${deck.slug}::${opponent.slug}`);
        if (!cell) {
          td.textContent = "·";
          td.title = "Not enough games in this window";
        } else {
          td.className = "cell";
          td.textContent = pct(cell.rate);
          td.style.background = cellColor(cell.rate);
          td.title = `${cell.wins}-${cell.losses} (${cell.matches} matches)`;
        }
      }
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
    wrapEl.replaceChildren(table);
}

function emptyMessage(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

function render() {
  if (!snapshot) {
    statusEl.textContent = "No snapshot yet. Press Refresh now to scrape Endstep.";
    wrapEl.replaceChildren(emptyMessage("No data loaded yet."));
    return;
  }
  const formatCount = Object.keys(snapshot.formats || {}).length;
  statusEl.textContent = `Updated ${formatTimestamp(snapshot.scrapedAt)} · ${snapshot.window} · ${snapshot.population} · top ${snapshot.topDecks} · ${formatCount} formats · via ${snapshot.backend}`;
  renderFormats();
  renderTable();
}

async function loadMeta() {
  const res = await fetch("/api/meta");
  if (res.status === 404) {
    snapshot = null;
    render();
    return;
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to load snapshot (${res.status})`);
  }
  snapshot = await res.json();
  render();
}

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  statusEl.textContent = "Scraping Endstep… this can take a few minutes.";
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || "Refresh failed");
    }
    snapshot = payload.data;
    render();
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    refreshBtn.disabled = false;
  }
});

loadMeta().catch((err) => {
  statusEl.textContent = err.message;
});
