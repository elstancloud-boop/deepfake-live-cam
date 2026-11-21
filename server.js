import "dotenv/config";
import express from "express";
import helmet from "helmet";
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
if (process.env.JWT_SECRET.length < 32) { console.error("JWT_SECRET must be 32+ chars"); process.exit(1); }
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_IPS = (process.env.ADMIN_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const IS_PROD = process.env.NODE_ENV === "production";

await init();
const decart = createDecartClient({ apiKey: process.env.DECART_API_KEY });
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://esm.sh"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://esm.sh", "https://api.decart.ai", "wss://api.decart.ai", "https://*.decart.ai", "wss://*.decart.ai"],
      mediaSrc: ["'self'", "blob:", "mediastream:"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

// CSRF: cookies are SameSite=Strict, plus every state-changing call must carry a custom header
// (cross-site forms/fetches cannot set it without a CORS preflight, which we never allow) and match our own origin.
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.path.startsWith("/api/ipn/") && req.path !== "/api/session/end-beacon") {
    if (req.get("x-requested-with") !== "dlc") return res.status(403).json({ error: "csrf" });
    const o = req.get("origin");
    if (o && o !== process.env.PUBLIC_URL) return res.status(403).json({ error: "origin" });
  }
  next();
});
app.use(express.static("public", { index: "index.html", maxAge: "5m" }));

// ---- rate limiting ----
const hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + ":" + req.ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < ms); arr.push(now); hits.set(k, arr);
  return arr.length > max ? res.status(429).json({ error: "rate_limited" }) : next();
};
app.use("/api", limit("all", 300, 60e3));

// ---- auth (JWT bound to a revocable DB session) ----
const COOKIE = { httpOnly: true, secure: IS_PROD, sameSite: "strict", path: "/" };
async function startAuth(req, res, userId) {
  const sid = crypto.randomUUID();
  const exp = new Date(Date.now() + 7 * 864e5);
  await q("INSERT INTO auth_sessions(id,user_id,ip,ua,expires_at) VALUES($1,$2,$3,$4,$5)", [sid, userId, req.ip, (req.get("user-agent") || "").slice(0, 200), exp]);
  res.cookie("t", jwt.sign({ sid, uid: userId }, process.env.JWT_SECRET, { expiresIn: "7d" }), { ...COOKIE, maxAge: 7 * 864e5 });
}
async function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.t, process.env.JWT_SECRET);
    const { rows } = await q(
      `SELECT u.* FROM auth_sessions a JOIN users u ON u.id=a.user_id
       WHERE a.id=$1 AND a.revoked=false AND a.expires_at>now()`, [p.sid]);
    if (!rows[0]) return res.status(401).json({ error: "login" });
    if (rows[0].banned) return res.status(403).json({ error: "banned" });
    req.user = rows[0]; req.sid = p.sid; next();
  } catch { res.status(401).json({ error: "login" }); }
}
const admin = [auth, (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  if (ADMIN_IPS.length && !ADMIN_IPS.includes(req.ip)) return res.status(403).json({ error: "ip_not_allowed" });
  next();
}];
const audit = (req, action, target, detail) =>
  q("INSERT INTO audit_log(admin_id,action,target,detail,ip) VALUES($1,$2,$3,$4,$5)", [req.user.id, action, String(target ?? ""), detail ? JSON.stringify(detail) : null, req.ip]);

const strongPw = p => typeof p === "string" && p.length >= 10 && p.length <= 128 && /[a-z]/i.test(p) && /\d/.test(p);
const DUMMY = bcrypt.hashSync("dummy-password-1", 12);

app.post("/api/signup", limit("su", 10, 3600e3), async (req, res) => {
  const { email, password, age18, tos } = req.body || {};
  if (age18 !== true || tos !== true) return res.status(400).json({ error: "You must confirm you are 18+ and accept the terms." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "") || email.length > 200) return res.status(400).json({ error: "Valid email required." });
  if (!strongPw(password)) return res.status(400).json({ error: "Password needs 10+ characters with letters and numbers." });
  const em = email.toLowerCase();
  try {
    const role = ADMIN_EMAILS.includes(em) ? "admin" : "user";
    const { rows } = await q("INSERT INTO users(email,pw_hash,role,age18_at,tos_at) VALUES($1,$2,$3,now(),now()) RETURNING id", [em, await bcrypt.hash(password, 12), role]);
    await startAuth(req, res, rows[0].id); res.json({ ok: true });
  } catch { res.status(409).json({ error: "Could not create account." }); }
});
app.post("/api/login", limit("li", 20, 600e3), async (req, res) => {
  const em = String(req.body?.email || "").toLowerCase();
  const { rows } = await q("SELECT * FROM users WHERE email=$1", [em]);
  const u = rows[0];
  if (u?.locked_until && new Date(u.locked_until) > new Date()) return res.status(429).json({ error: "Account temporarily locked. Try again later." });
  const ok = await bcrypt.compare(String(req.body?.password || ""), u?.pw_hash || DUMMY);
  if (!u || !ok) {
    if (u) await q("UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1", [u.id]);
    return res.status(401).json({ error: "Wrong email or password." });
  }
  await q("UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1", [u.id]);
  await startAuth(req, res, u.id); res.json({ ok: true });
});
app.post("/api/logout", auth, async (req, res) => {
  await q("UPDATE auth_sessions SET revoked=true WHERE id=$1", [req.sid]); res.clearCookie("t", COOKIE); res.json({ ok: true });
});
app.get("/api/me", auth, async (req, res) => {
  const v = await q("SELECT id,label FROM voices WHERE enabled=true ORDER BY id");
  res.json({ email: req.user.email, role: req.user.role, seconds: req.user.seconds, pricePerMin: PRICE_PER_MIN, voices: ELEVEN_KEY ? v.rows : [] });
});

// ---- consent (required before every session) ----
app.post("/api/consent", auth, limit("co", 60, 3600e3), async (req, res) => {
  const { photoSha256, ownFaceOrPermission, noDeception, voiceId } = req.body || {};
  if (ownFaceOrPermission !== true || noDeception !== true || !/^[a-f0-9]{64}$/.test(photoSha256 || ""))
    return res.status(400).json({ error: "Both confirmations are required." });
  let vid = null;
  if (voiceId) {
    const v = await q("SELECT id FROM voices WHERE id=$1 AND enabled=true", [Number(voiceId)]);
    if (!v.rows[0]) return res.status(400).json({ error: "Unknown voice." });
    vid = String(v.rows[0].id);
  }
  const { rows } = await q("INSERT INTO consents(user_id,photo_sha256,voice_id,ip) VALUES($1,$2,$3,$4) RETURNING id", [req.user.id, photoSha256, vid, req.ip]);
  res.json({ consentId: rows[0].id });
});

// ---- sessions + metering ----
const mint = async () => (await decart.tokens.create()).apiKey;
app.post("/api/session/start", auth, limit("ss", 30, 600e3), async (req, res) => {
  const { consentId, fast } = req.body || {};
  const c = await q("SELECT id,voice_id FROM consents WHERE id=$1 AND user_id=$2 AND created_at>now()-interval '1 hour'", [Number(consentId), req.user.id]);
  if (!c.rows[0]) return res.status(400).json({ error: "Consent required." });
  if (req.user.seconds <= 0) return res.status(402).json({ error: "No minutes left. Buy more." });
  await q("UPDATE sessions SET ended_at=now() WHERE user_id=$1 AND ended_at IS NULL", [req.user.id]);
  const id = crypto.randomUUID();
  await q("INSERT INTO sessions(id,user_id,consent_id,fast,voice) VALUES($1,$2,$3,$4,$5)", [id, req.user.id, c.rows[0].id, fast === true, !!c.rows[0].voice_id]);
  res.json({ sessionId: id, token: await mint(), seconds: req.user.seconds });
});
app.post("/api/realtime-token", auth, limit("tk", 60, 600e3), async (req, res) => {
  const s = await q("SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL", [req.body?.sessionId, req.user.id]);
  if (!s.rows[0] || req.user.seconds <= 0) return res.status(403).json({ error: "no_active_session" });
  res.json({ apiKey: await mint() });
});
app.post("/api/session/beat", auth, async (req, res) => {
  const { rows } = await q("SELECT * FROM sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL", [req.body?.sessionId, req.user.id]);
  const s = rows[0]; if (!s) return res.json({ stop: true, seconds: req.user.seconds });
  const elapsed = Math.min(20, Math.max(0, Math.ceil((Date.now() - new Date(s.last_beat)) / 1000)));
  const cost = Math.ceil(elapsed * (1 + (s.fast ? 1 : 0) + (s.voice ? 0.5 : 0)));
  const u = await q("UPDATE users SET seconds=GREATEST(seconds-$1,0) WHERE id=$2 RETURNING seconds", [cost, req.user.id]);
  await q("UPDATE sessions SET last_beat=now(), seconds_billed=seconds_billed+$1 WHERE id=$2", [cost, s.id]);
  const left = u.rows[0].seconds;
  if (left <= 0) await q("UPDATE sessions SET ended_at=now() WHERE id=$1", [s.id]);
  res.json({ stop: left <= 0, seconds: left });
});
app.post("/api/session/end", auth, async (req, res) => {
  await q("UPDATE sessions SET ended_at=now() WHERE id=$1 AND user_id=$2", [req.body?.sessionId, req.user.id]); res.json({ ok: true });
});

// ---- voice conversion (ElevenLabs Voice Changer, chunked) ----
// Only admin-approved voices are usable; there is no endpoint to clone or add voices from users.
app.post("/api/voice/convert", auth, limit("vc", 40, 60e3), express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  if (!ELEVEN_KEY) return res.status(503).json({ error: "voice_unavailable" });
  const sid = req.get("x-session-id");
  const s = await q("SELECT s.voice, c.voice_id FROM sessions s JOIN consents c ON c.id=s.consent_id WHERE s.id=$1 AND s.user_id=$2 AND s.ended_at IS NULL", [sid, req.user.id]);
  if (!s.rows[0]?.voice || !s.rows[0].voice_id) return res.status(403).json({ error: "voice_not_enabled" });
  const v = await q("SELECT eleven_voice_id FROM voices WHERE id=$1 AND enabled=true", [Number(s.rows[0].voice_id)]);
  if (!v.rows[0] || !Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: "bad_request" });
  try {
    const fd = new FormData();
    fd.append("audio", new Blob([req.body], { type: req.get("content-type") || "audio/webm" }), "chunk.webm");
    fd.append("model_id", "eleven_multilingual_sts_v2");
    const r = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(v.rows[0].eleven_voice_id)}?output_format=mp3_44100_64`,
      { method: "POST", headers: { "xi-api-key": ELEVEN_KEY }, body: fd });
    if (!r.ok) { console.error("eleven", r.status); return res.status(502).json({ error: "voice_failed" }); }
    res.set("Content-Type", "audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.status(502).json({ error: "voice_failed" }); }
});

// ---- payments ----
app.post("/api/checkout", auth, limit("ck", 20, 3600e3), async (req, res) => {
  const minutes = Math.floor(Number(req.body?.minutes));
  const provider = req.body?.provider || "nowpayments";
  if (!providers[provider]) return res.status(400).json({ error: "Unknown provider." });
  if (!(minutes >= 5 && minutes <= 120)) return res.status(400).json({ error: "5 to 120 minutes (5-minute minimum, $10)." });
  const order = { id: crypto.randomUUID(), minutes, usd: (minutes * PRICE_PER_MIN).toFixed(2) };
  await q("INSERT INTO orders(id,user_id,minutes,usd,provider) VALUES($1,$2,$3,$4,$5)", [order.id, req.user.id, minutes, order.usd, provider]);
  try {
    const base = process.env.PUBLIC_URL;
    const inv = await providers[provider].createInvoice(order, { ipnUrl: `${base}/api/ipn/${provider}`, successUrl: `${base}/?paid=1`, cancelUrl: `${base}/` });
    await q("UPDATE orders SET provider_ref=$1 WHERE id=$2", [inv.ref, order.id]);
    res.json({ url: inv.url });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not create invoice." }); }
});
app.post("/api/ipn/:provider", async (req, res) => {
  const ev = providers[req.params.provider]?.verifyWebhook(req);
  if (!ev) return res.status(401).end();
  if (ev.paid) {
    const o = await q("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending' RETURNING user_id,minutes", [ev.orderId]);
    if (o.rows[0]) await q("UPDATE users SET seconds=seconds+$1 WHERE id=$2", [o.rows[0].minutes * 60, o.rows[0].user_id]);
  }
  res.json({ ok: true });
});

// ---- abuse reports ----
app.post("/api/report", limit("rp", 10, 3600e3), async (req, res) => {
  let uid = null;
  try { uid = jwt.verify(req.cookies.t, process.env.JWT_SECRET).uid; } catch {}
  await q("INSERT INTO reports(user_id,reason) VALUES($1,$2)", [uid, String(req.body?.reason || "").slice(0, 2000)]);
  res.json({ ok: true });
});

// ================= ADMIN API =================
const A = express.Router();
A.use(admin);
A.get("/stats", async (_req, res) => {
  const r = await q(`SELECT
    (SELECT count(*) FROM users) users,
    (SELECT count(*) FROM users WHERE banned) banned,
    (SELECT count(*) FROM sessions WHERE ended_at IS NULL) live_sessions,
    (SELECT coalesce(sum(usd),0) FROM orders WHERE status='paid') revenue_usd,
    (SELECT coalesce(sum(seconds_billed),0) FROM sessions) seconds_billed,
    (SELECT count(*) FROM reports WHERE status='open') open_reports`);
  res.json(r.rows[0]);
});
A.get("/users", async (req, res) => {
  const s = `%${String(req.query.q || "").toLowerCase()}%`;
  const r = await q("SELECT id,email,role,seconds,banned,ban_reason,created_at FROM users WHERE email LIKE $1 ORDER BY id DESC LIMIT 100", [s]);
  res.json(r.rows);
});
A.get("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [u, s, o, c] = await Promise.all([
    q("SELECT id,email,role,seconds,banned,ban_reason,created_at FROM users WHERE id=$1", [id]),
    q("SELECT id,fast,voice,started_at,ended_at,seconds_billed FROM sessions WHERE user_id=$1 ORDER BY started_at DESC LIMIT 50", [id]),
    q("SELECT id,minutes,usd,provider,status,created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [id]),
    q("SELECT id,photo_sha256,voice_id,ip,created_at FROM consents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [id]),
  ]);
  res.json({ user: u.rows[0], sessions: s.rows, orders: o.rows, consents: c.rows });
});
A.post("/users/:id/ban", async (req, res) => {
  const id = Number(req.params.id), ban = req.body?.banned === true;
  if (id === req.user.id) return res.status(400).json({ error: "cannot_ban_self" });
  await q("UPDATE users SET banned=$1, ban_reason=$2 WHERE id=$3", [ban, ban ? String(req.body?.reason || "").slice(0, 500) : null, id]);
  if (ban) { await q("UPDATE auth_sessions SET revoked=true WHERE user_id=$1", [id]); await q("UPDATE sessions SET ended_at=now() WHERE user_id=$1 AND ended_at IS NULL", [id]); }
  await audit(req, ban ? "ban" : "unban", id, { reason: req.body?.reason }); res.json({ ok: true });
});
A.post("/users/:id/credit", async (req, res) => {
  const id = Number(req.params.id), minutes = Math.trunc(Number(req.body?.minutes));
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 600) return res.status(400).json({ error: "bad_minutes" });
  const r = await q("UPDATE users SET seconds=GREATEST(seconds+$1,0) WHERE id=$2 RETURNING seconds", [minutes * 60, id]);
  await audit(req, "credit", id, { minutes }); res.json({ seconds: r.rows[0]?.seconds });
});
A.post("/users/:id/revoke-logins", async (req, res) => {
  await q("UPDATE auth_sessions SET revoked=true WHERE user_id=$1", [Number(req.params.id)]);
  await audit(req, "revoke_logins", req.params.id); res.json({ ok: true });
});
A.get("/sessions/live", async (_req, res) =>
  res.json((await q("SELECT s.id,u.email,s.fast,s.voice,s.started_at,s.seconds_billed FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.ended_at IS NULL ORDER BY s.started_at")).rows));
A.post("/sessions/:id/kill", async (req, res) => {
  await q("UPDATE sessions SET ended_at=now() WHERE id=$1", [req.params.id]); await audit(req, "kill_session", req.params.id); res.json({ ok: true });
});
A.get("/orders", async (_req, res) =>
  res.json((await q("SELECT o.id,u.email,o.minutes,o.usd,o.provider,o.status,o.created_at FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200")).rows));
A.get("/reports", async (_req, res) =>
  res.json((await q("SELECT r.id,r.user_id,u.email,r.reason,r.status,r.created_at FROM reports r LEFT JOIN users u ON u.id=r.user_id ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 200")).rows));
A.post("/reports/:id/resolve", async (req, res) => {
  await q("UPDATE reports SET status='resolved' WHERE id=$1", [Number(req.params.id)]); await audit(req, "resolve_report", req.params.id); res.json({ ok: true });
});
A.get("/voices", async (_req, res) => res.json((await q("SELECT * FROM voices ORDER BY id")).rows));
A.post("/voices", async (req, res) => {
  const { label, elevenVoiceId } = req.body || {};
  if (!label || !/^[A-Za-z0-9]{10,40}$/.test(elevenVoiceId || "")) return res.status(400).json({ error: "bad_voice" });
  const r = await q("INSERT INTO voices(label,eleven_voice_id) VALUES($1,$2) RETURNING id", [String(label).slice(0, 60), elevenVoiceId]);
  await audit(req, "add_voice", r.rows[0].id, { label }); res.json({ id: r.rows[0].id });
});
A.post("/voices/:id/toggle", async (req, res) => {
  await q("UPDATE voices SET enabled=NOT enabled WHERE id=$1", [Number(req.params.id)]); await audit(req, "toggle_voice", req.params.id); res.json({ ok: true });
});
A.get("/audit", async (_req, res) => res.json((await q("SELECT a.*,u.email admin_email FROM audit_log a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 200")).rows));
app.use("/api/admin", A);

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "server_error" }); });
app.listen(process.env.PORT || 3000, () => console.log("up"));
