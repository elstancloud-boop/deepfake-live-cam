import "dotenv/config";
import express from "express";
import { createDecartClient } from "@decartai/sdk";

const key = process.env.DECART_API_KEY;
if (!key) {
  console.error("Missing DECART_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}
const ACCESS_CODE = process.env.ACCESS_CODE;
if (!ACCESS_CODE) {
  console.error("Missing ACCESS_CODE. Set a secret code so strangers can't spend your Decart credits.");
  process.exit(1);
}
const decart = createDecartClient({ apiKey: key });
// Simple per-IP rate limit: 20 tokens per 10 minutes
const hits = new Map();
const limited = ip => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
};
const app = express();
app.set("trust proxy", 1);
app.use(express.static("public"));

// Short-lived token so the permanent key never reaches the browser.
app.post("/api/realtime-token", async (req, res) => {
  if (req.get("x-access-code") !== ACCESS_CODE) return res.status(401).json({ error: "bad_code" });
  if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  try {
    const token = await decart.tokens.create();
    res.json({ apiKey: token.apiKey });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "token_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Open http://localhost:${port}`));
