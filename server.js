const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const dataDir = path.join(__dirname, "data");
const fs = require("fs");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "review-card.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'google',
  destination_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PLATFORMS = new Set(["google", "facebook", "instagram", "tiktok", "other"]);

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeCardId(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(`${ip}|nfc-review-card`).digest("hex");
}

function recordScan(cardId, req) {
  db.prepare(`
    INSERT INTO scans (card_id, user_agent, ip_hash)
    VALUES (?, ?, ?)
  `).run(cardId, req.get("user-agent") || "", hashIp(req.ip || ""));
}

// NFC tags point here. Always log the scan first, then redirect if registered.
app.get("/c/:cardId", (req, res) => {
  const cardId = normalizeCardId(req.params.cardId);
  if (!cardId) return res.status(400).send("Invalid card");

  recordScan(cardId, req);

  const row = db.prepare(`
    SELECT card_id, active, business_name, platform, destination_url
    FROM cards WHERE card_id = ?
  `).get(cardId);

  if (!row) {
    return res.status(404).send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card not registered</title>
<style>body{font-family:system-ui;text-align:center;padding:40px;color:#182033}
.id{background:#f3f4f6;padding:10px 14px;border-radius:8px;display:inline-block;margin-top:12px;font-family:monospace}</style>
</head><body>
<h1>Card scanned</h1>
<p>This NFC card is not registered yet.</p>
<div class="id">${cardId}</div>
<p style="color:#667085;margin-top:20px">Open the dashboard to register this card and attach a business.</p>
</body></html>`);
  }

  if (!row.active) {
    return res.status(404).send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card unavailable</title></head>
<body style="font-family:system-ui;text-align:center;padding:40px">
<h1>Card unavailable</h1><p>This card is currently disabled.</p>
</body></html>`);
  }

  return res.redirect(row.destination_url);
});

app.get("/api/cards", (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.card_id, c.business_name, c.platform, c.destination_url,
           c.active, c.created_at, COUNT(s.id) AS scans
    FROM cards c
    LEFT JOIN scans s ON s.card_id = c.card_id
    GROUP BY c.id
    ORDER BY c.id DESC
  `).all();
  res.json(rows);
});

// Card ID first, then business + platform link
app.post("/api/cards", (req, res) => {
  const cardId = normalizeCardId(req.body.cardId);
  const businessName = String(req.body.businessName || "").trim();
  const platform = String(req.body.platform || "google").toLowerCase();
  const destinationUrl = String(req.body.destinationUrl || "").trim();

  if (!cardId) return res.status(400).json({ error: "Card ID is required — scan or enter the card first" });
  if (!businessName) return res.status(400).json({ error: "Business name is required" });
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: "Invalid platform" });
  if (!validUrl(destinationUrl)) return res.status(400).json({ error: "Enter a valid URL (https://...)" });

  try {
    db.prepare(`
      INSERT INTO cards (card_id, business_name, platform, destination_url)
      VALUES (?, ?, ?, ?)
    `).run(cardId, businessName, platform, destinationUrl);

    res.json({
      cardId,
      businessName,
      platform,
      url: `${BASE_URL}/c/${encodeURIComponent(cardId)}`
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That card ID is already registered" });
    }
    res.status(500).json({ error: "Could not register card" });
  }
});

app.patch("/api/cards/:cardId", (req, res) => {
  const cardId = normalizeCardId(req.params.cardId);
  const existing = db.prepare("SELECT * FROM cards WHERE card_id = ?").get(cardId);
  if (!existing) return res.status(404).json({ error: "Card not found" });

  if (req.body.active !== undefined) {
    db.prepare("UPDATE cards SET active = ? WHERE card_id = ?").run(req.body.active ? 1 : 0, cardId);
    return res.json({ ok: true });
  }

  const businessName = req.body.businessName !== undefined
    ? String(req.body.businessName || "").trim() : existing.business_name;
  const platform = req.body.platform !== undefined
    ? String(req.body.platform || "google").toLowerCase() : existing.platform;
  const destinationUrl = req.body.destinationUrl !== undefined
    ? String(req.body.destinationUrl || "").trim() : existing.destination_url;

  if (!businessName) return res.status(400).json({ error: "Business name is required" });
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: "Invalid platform" });
  if (!validUrl(destinationUrl)) return res.status(400).json({ error: "Enter a valid URL" });

  db.prepare(`
    UPDATE cards SET business_name = ?, platform = ?, destination_url = ?
    WHERE card_id = ?
  `).run(businessName, platform, destinationUrl, cardId);

  res.json({ ok: true });
});

app.get("/api/pending", (req, res) => {
  const rows = db.prepare(`
    SELECT s.card_id, COUNT(*) AS scan_count, MAX(s.created_at) AS last_scan
    FROM scans s
    LEFT JOIN cards c ON c.card_id = s.card_id
    WHERE c.id IS NULL
    GROUP BY s.card_id
    ORDER BY last_scan DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

app.get("/api/stats", (req, res) => {
  const cards = db.prepare("SELECT COUNT(*) AS n FROM cards").get().n;
  const activeCards = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE active = 1").get().n;
  const scans = db.prepare("SELECT COUNT(*) AS n FROM scans").get().n;
  const pending = db.prepare(`
    SELECT COUNT(DISTINCT s.card_id) AS n
    FROM scans s LEFT JOIN cards c ON c.card_id = s.card_id
    WHERE c.id IS NULL
  `).get().n;

  const recent = db.prepare(`
    SELECT s.card_id, c.business_name, c.platform, s.created_at,
           CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS registered
    FROM scans s
    LEFT JOIN cards c ON c.card_id = s.card_id
    ORDER BY s.id DESC
    LIMIT 25
  `).all();

  res.json({ cards, activeCards, scans, pending, recent });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/c/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NFC Review Card running on ${BASE_URL}`);
});
