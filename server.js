import "dotenv/config";
import express from "express";
import { createDecartClient } from "@decartai/sdk";

const key = process.env.DECART_API_KEY;
if (!key) {
  console.error("Missing DECART_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}
const decart = createDecartClient({ apiKey: key });
const app = express();
app.use(express.static("public"));

// Short-lived token so the permanent key never reaches the browser.
app.post("/api/realtime-token", async (_req, res) => {
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
