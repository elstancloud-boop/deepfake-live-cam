import "dotenv/config";
import express from "express";
import { createDecartClient } from "@decartai/sdk";
import fs from "fs";

const key = process.env.DECART_API_KEY;
if (!key) { console.error("Missing DECART_API_KEY."); process.exit(1); }
const ACCESS_CODE = process.env.ACCESS_CODE;
if (!ACCESS_CODE) { console.error("Missing ACCESS_CODE."); process.exit(1); }
const PAY_WALLET = process.env.PAY_WALLET || "0x0000000000000000000000000000000000000000";
const PRICE_USD = parseFloat(process.env.PRICE_USD || "1.00");
const RPC = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "3", 10);
const SESSION_HOURS = 24;
const STORE = "sessions.json";

const decart = createDecartClient({ apiKey: key });
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static("dist"));
app.use(express.static("public"));

// --- Persistent session store (survives restarts) ---
const sessions = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE, "utf8")))); }
  catch { return new Map(); }
})();
function save() {
  try { fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(sessions))); } catch (e) { console.error(e); }
}

const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 600000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
};

const ethPrice = { usd: 0, at: 0 };
async function getEthPrice() {
  if (Date.now() - ethPrice.at < 300000) return ethPrice.usd;
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  ethPrice.usd = (await r.json()).ethereum.usd;
  ethPrice.at = Date.now();
  return ethPrice.usd;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

// Create a payment request
app.get("/api/pay-request", async (_req, res) => {
  try {
    const eth = await getEthPrice();
    const amount = +(PRICE_USD / eth).toFixed(6);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { status: "pending", amount, tx: null, expiry: 0, consent: false, createdAt: Date.now() });
    save();
    res.json({ sessionId, wallet: PAY_WALLET, amountEth: amount });
  } catch (e) { console.error(e); res.status(500).json({ error: "price_failed" }); }
});

// Verify payment: recipient, amount, mined AND enough confirmations, replay-protected
app.post("/api/pay-verify", async (req, res) => {
  const { sessionId, txHash } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.status !== "pending") return res.status(400).json({ error: "bad_session" });
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return res.status(400).json({ error: "bad_tx" });
  try {
    const tx = await rpc("eth_getTransactionByHash", [txHash]);
    if (!tx) return res.status(400).json({ error: "tx_not_found" });
    const toOk = (tx.to || "").toLowerCase() === PAY_WALLET.toLowerCase();
    const weiNeeded = BigInt(Math.round(s.amount * 1e6)) * 1000000000000n;
    const valOk = BigInt(tx.value) >= weiNeeded;
    if (!toOk || !valOk || !tx.blockNumber) return res.status(400).json({ error: "tx_mismatch" });

    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    const confirms = head - parseInt(tx.blockNumber, 16) + 1;
    if (confirms < CONFIRMATIONS) return res.status(400).json({ error: "unconfirmed", confirms });

    for (const v of sessions.values()) if (v.tx === txHash) return res.status(400).json({ error: "tx_reused" });
    s.status = "paid";
    s.tx = txHash;
    s.expiry = Date.now() + SESSION_HOURS * 3600000;
    save();
    res.json({ ok: true, confirms, expires: s.expiry });
  } catch (e) { console.error(e); res.status(500).json({ error: "verify_failed" }); }
});

// Record consent: required before a token is issued for a paid session
app.post("/api/consent", (req, res) => {
  const { sessionId, ownFace, noImpersonation } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(400).json({ error: "bad_session" });
  if (!ownFace || !noImpersonation) return res.status(400).json({ error: "consent_required" });
  s.consent = true;
  s.consentAt = Date.now();
  s.consentIp = req.ip;
  save();
  res.json({ ok: true });
});

// Token endpoint: admin access code OR paid session with recorded consent
app.post("/api/realtime-token", async (req, res) => {
  const code = req.get("x-access-code");
  const sessionId = req.get("x-session-id");
  let authorized = false;
  if (code && code === ACCESS_CODE) authorized = true;
  else if (sessionId) {
    const s = sessions.get(sessionId);
    if (s?.status === "paid" && s.consent && Date.now() < s.expiry) authorized = true;
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });
  if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  try {
    const token = await decart.tokens.create();
    res.json({ apiKey: token.apiKey });
  } catch (e) { console.error(e); res.status(500).json({ error: "token_failed" }); }
});

app.listen(process.env.PORT || 3001, () => console.log("API on :" + (process.env.PORT || 3001)));
