import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createDecartClient } from "@decartai/sdk";
import { q, init } from "./db.js";
import { providers, PRICE_PER_MIN } from "./payments.js";

for (const k of ["DECART_API_KEY", "DATABASE_URL", "JWT_SECRET", "PUBLIC_URL"]) {
  if (!process.env[k]) { console.error("Missing env " + k); process.exit(1); }
}
await init();
const decart = createDecartClient({ apiKey: process.env.DECART_API_KEY });
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static("public"));

// ---- tiny rate limiter ----
const hits = new Map();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + req.ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < ms); arr.push(now); hits.set(k, arr);
  return arr.length > max ? res.status(429).json({ error: "rate_limited" }) : next();
};

// ---- auth ----
const sign = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const setCookie = (res, id) => res.cookie("t", sign(id), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 7 * 864e5 });
async function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.t, process.env.JWT_SECRET);
    const { rows } = await q("SELECT * FROM users WHERE id=$1", [id]);
    if (!rows[0]) return res.status(401).json({ error: "login" });
    if (rows[0].banned) return res.status(403).json({ error: "banned" });
    req.user = rows[0]; next();
  } catch { res.status(401).json({ error: "login" }); }
}

app.post("/api/signup", limit("su", 10, 3600e3), async (req, res) => {
  const { email, password, age18, tos } = req.body || {};
  if (!age18 || !tos) return res.status(400).json({ error: "You must confirm you are 18+ and accept the terms." });
  if (!/^\S+@\S+\.\S+$/.test(email || "") || (password || "").length < 8) return res.status(400).json({ error: "Valid email and 8+ char password required." });
  try {
    const { rows } = await q(
      "INSERT INTO users(email,pw_hash,age18_at,tos_at) VALUES(lower($1),$2,now(),now()) RETURNING id",
      [email, await bcrypt.hash(password, 11)]);
    setCookie(res, rows[0].id); res.json({ ok: true });
  } catch { res.status(409).json({ error: "Email already registered." }); }
});
app.post("/api/login", limit("li", 20, 600e3), async (req, res) => {
  const { rows } = await q("SELECT * FROM users WHERE email=lower($1)", [req.body?.email || ""]);
  if (!rows[0] || !(await bcrypt.compare(req.body?.password || "", rows[0].pw_hash))) return res.status(401).json({ error: "Wrong email or password." });
  setCookie(res, rows[0].id); res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => { res.clearCookie("t"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ email: req.user.email, seconds: req.user.seconds, pricePerMin: PRICE_PER_MIN }));

// ---- consent (required before every session) ----
app.post("/api/consent", auth, async (req, res) => {
  const { photoSha256, ownFaceOrPermission, noDeception } = req.body || {};
  if (!ownFaceOrPermission || !noDeception || !/^[a-f0-9]{64}$/.test(photoSha256 || ""))
    return res.status(400).json({ error: "Both confirmations are required." });
  const { rows } = await q("INSERT INTO consents(user_id,photo_sha256,ip) VALUES($1,$2,$3) RETURNING id", [req.user.id, photoSha256, req.ip]);
  res.json({ consentId: rows[0].id });
});

// ---- sessions + metering ----
const mint = async () => (await decart.tokens.create()).apiKey;
app.post("/api/session/start", auth, limit("ss", 30, 600e3), async (req, res) => {
  const { consentId, fast } = req.body || {};
  const c = await q("SELECT id FROM consents WHERE id=$1 AND user_id=$2 AND created_at > now() - interval '1 hour'", [consentId, req.user.id]);
  if (!c.rows[0]) return res.status(400).json({ error: "Consent required." });
  if (req.user.seconds <= 0) return res.status(402).json({ error: "No minutes left. Buy more." });
  await q("UPDATE sessions SET ended_at=now() WHERE user_id=$1 AND ended_at IS NULL", [req.user.id]);
  const id = crypto.randomUUID();
  await q("INSERT INTO sessions(id,user_id,consent_id,fast) VALUES($1,$2,$3,$4)", [id, req.user.id, consentId, !!fast]);
  res.json({ sessionId: id, token: await mint(), seconds: req.user.seconds });
});
app.post("/api/realtime-token", auth, async (req, res) => {
  const s = await q("SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL", [req.body?.sessionId, req.user.id]);
  if (!s.rows[0] || req.user.seconds <= 0) return res.status(403).json({ error: "no_active_session" });
  res.json({ apiKey: await mint() });
});
app.post("/api/session/beat", auth, async (req, res) => {
  const { rows } = await q("SELECT * FROM sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL", [req.body?.sessionId, req.user.id]);
  const s = rows[0]; if (!s) return res.json({ stop: true, seconds: req.user.seconds });
  const elapsed = Math.min(20, Math.max(0, Math.ceil((Date.now() - new Date(s.last_beat)) / 1000)));
  const cost = elapsed * (s.fast ? 2 : 1);
  const u = await q("UPDATE users SET seconds=GREATEST(seconds-$1,0) WHERE id=$2 RETURNING seconds", [cost, req.user.id]);
  await q("UPDATE sessions SET last_beat=now(), seconds_billed=seconds_billed+$1 WHERE id=$2", [cost, s.id]);
  const left = u.rows[0].seconds;
  if (left <= 0) await q("UPDATE sessions SET ended_at=now() WHERE id=$1", [s.id]);
  res.json({ stop: left <= 0, seconds: left });
});
app.post("/api/session/end", auth, async (req, res) => {
  await q("UPDATE sessions SET ended_at=now() WHERE id=$1 AND user_id=$2", [req.body?.sessionId, req.user.id]);
  res.json({ ok: true });
});

// ---- payments ----
app.post("/api/checkout", auth, limit("co", 20, 3600e3), async (req, res) => {
  const minutes = Math.floor(Number(req.body?.minutes));
  const provider = req.body?.provider || "nowpayments";
  if (!providers[provider]) return res.status(400).json({ error: "Unknown provider." });
  if (!(minutes >= 1 && minutes <= 120)) return res.status(400).json({ error: "1 to 120 minutes." });
  const order = { id: crypto.randomUUID(), minutes, usd: (minutes * PRICE_PER_MIN).toFixed(2) };
  await q("INSERT INTO orders(id,user_id,minutes,usd,provider) VALUES($1,$2,$3,$4,$5)", [order.id, req.user.id, minutes, order.usd, provider]);
  try {
    const base = process.env.PUBLIC_URL;
    const inv = await providers[provider].createInvoice(order, {
      ipnUrl: `${base}/api/ipn/${provider}`, successUrl: `${base}/?paid=1`, cancelUrl: `${base}/`,
    });
    await q("UPDATE orders SET provider_ref=$1 WHERE id=$2", [inv.ref, order.id]);
    res.json({ url: inv.url });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not create invoice." }); }
});
app.post("/api/ipn/:provider", async (req, res) => {
  const p = providers[req.params.provider];
  const ev = p?.verifyWebhook(req);
  if (!ev) return res.status(401).end();
  if (ev.paid) {
    // idempotent: only the first transition pending->paid credits minutes
    const o = await q("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending' RETURNING user_id,minutes", [ev.orderId]);
    if (o.rows[0]) await q("UPDATE users SET seconds=seconds+$1 WHERE id=$2", [o.rows[0].minutes * 60, o.rows[0].user_id]);
  }
  res.json({ ok: true });
});

// ---- abuse reporting ----
app.post("/api/report", limit("rp", 10, 3600e3), async (req, res) => {
  await q("INSERT INTO reports(reason) VALUES($1)", [String(req.body?.reason || "").slice(0, 2000)]);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log("up"));
