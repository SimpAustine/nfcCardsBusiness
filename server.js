const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const dataDir = path.join(__dirname, "data");
const fs = require("fs");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "review-card.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  google_review_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL UNIQUE,
  business_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
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

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key || req.body.adminKey;
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

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
  return crypto.createHash("sha256").update(`${ip}|${ADMIN_KEY}`).digest("hex");
}

// Public card endpoint: this is what the NFC tag points to.
app.get("/c/:cardId", (req, res) => {
  const cardId = normalizeCardId(req.params.cardId);

  const row = db.prepare(`
    SELECT c.card_id, c.active, b.google_review_url, b.name
    FROM cards c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.card_id = ?
  `).get(cardId);

  if (!row || !row.active) {
    return res.status(404).send(`
      <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Card unavailable</title></head>
      <body style="font-family:system-ui;text-align:center;padding:40px">
      <h1>Card unavailable</h1><p>This review card is not active.</p>
      </body></html>
    `);
  }

  db.prepare(`
    INSERT INTO scans (card_id, user_agent, ip_hash)
    VALUES (?, ?, ?)
  `).run(
    cardId,
    req.get("user-agent") || "",
    hashIp(req.ip || "")
  );

  return res.redirect(row.google_review_url);
});

app.get("/api/businesses", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.name, b.google_review_url, b.created_at,
           COUNT(c.id) AS card_count
    FROM businesses b
    LEFT JOIN cards c ON c.business_id = b.id
    GROUP BY b.id
    ORDER BY b.id DESC
  `).all();
  res.json(rows);
});

app.post("/api/businesses", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const googleReviewUrl = String(req.body.googleReviewUrl || "").trim();

  if (!name) return res.status(400).json({ error: "Business name is required" });
  if (!validUrl(googleReviewUrl)) {
    return res.status(400).json({ error: "Enter a valid Google review URL" });
  }

  const result = db.prepare(`
    INSERT INTO businesses (name, google_review_url)
    VALUES (?, ?)
  `).run(name, googleReviewUrl);

  res.json({ id: result.lastInsertRowid });
});

app.get("/api/cards", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.card_id, c.active, c.created_at,
           b.id AS business_id, b.name AS business_name,
           COUNT(s.id) AS scans
    FROM cards c
    JOIN businesses b ON b.id = c.business_id
    LEFT JOIN scans s ON s.card_id = c.card_id
    GROUP BY c.id
    ORDER BY c.id DESC
  `).all();
  res.json(rows);
});

app.post("/api/cards", requireAdmin, (req, res) => {
  const cardId = normalizeCardId(req.body.cardId);
  const businessId = Number(req.body.businessId);

  if (!cardId) return res.status(400).json({ error: "Card ID is required" });
  if (!Number.isInteger(businessId) || businessId < 1) {
    return res.status(400).json({ error: "Valid business is required" });
  }

  const business = db.prepare("SELECT id FROM businesses WHERE id = ?").get(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });

  try {
    db.prepare(`
      INSERT INTO cards (card_id, business_id)
      VALUES (?, ?)
    `).run(cardId, businessId);
    res.json({
      cardId,
      url: `${BASE_URL}/c/${encodeURIComponent(cardId)}`
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That card ID is already registered" });
    }
    res.status(500).json({ error: "Could not create card" });
  }
});

app.patch("/api/cards/:cardId", requireAdmin, (req, res) => {
  const cardId = normalizeCardId(req.params.cardId);
  const active = req.body.active ? 1 : 0;

  const result = db.prepare(`
    UPDATE cards SET active = ? WHERE card_id = ?
  `).run(active, cardId);

  if (!result.changes) return res.status(404).json({ error: "Card not found" });
  res.json({ ok: true });
});

app.get("/api/stats", requireAdmin, (req, res) => {
  const businesses = db.prepare("SELECT COUNT(*) AS n FROM businesses").get().n;
  const cards = db.prepare("SELECT COUNT(*) AS n FROM cards").get().n;
  const activeCards = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE active = 1").get().n;
  const scans = db.prepare("SELECT COUNT(*) AS n FROM scans").get().n;

  const recent = db.prepare(`
    SELECT s.card_id, b.name AS business_name, s.created_at
    FROM scans s
    LEFT JOIN cards c ON c.card_id = s.card_id
    LEFT JOIN businesses b ON b.id = c.business_id
    ORDER BY s.id DESC
    LIMIT 20
  `).all();

  res.json({ businesses, cards, activeCards, scans, recent });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/c/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NFC Review Card running on ${BASE_URL}`);
});