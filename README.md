# Deepfake Live Cam (Decart edition)

Browser-based live face swap with no local GPU. Your webcam streams over WebRTC to Decart's Lucy 2.6 realtime model, which swaps in the person from your reference photo, and the result streams back.

## Run
1. Create an API key at https://platform.decart.ai
2. `cp .env.example .env`, paste the key, and set `ACCESS_CODE` to a secret of your choice (never commit `.env`)
3. `npm install && npm start`
4. Open http://localhost:3000, choose a face photo, click Start.

The server only mints short-lived tokens, so the permanent key never reaches the browser.

## Cost
Billed by Decart per second of active streaming: $0.02/sec standard, $0.04/sec fast mode (see https://docs.platform.decart.ai/getting-started/pricing). New accounts get free credits. Click Stop when done. The page shows an estimated cost.

## Notes
- The old local Python version (`server.py`, `swapper.py`, `Dockerfile`, `requirements.txt`, `static/`) is still in the repo as an offline option that needs an NVIDIA GPU.
- Use only photos of people who have agreed to it. Decart's terms apply.

## Deploy (Render)
Use the included `render.yaml` Blueprint. Set `DECART_API_KEY` and `ACCESS_CODE` in the Render dashboard. Anyone with the access code can spend your Decart credits, so keep it private.
