# Deepfake Live Cam (public, paid edition)

Browser live face swap on Decart Lucy 2.6. Accounts, a required consent step, prepaid minutes metered by heartbeat, and crypto checkout via NOWPayments.

- Decart's AI-generated watermark stays on the output. Do not remove it.
- Before charging the public, confirm Decart's commercial/reseller terms with contact@decart.ai, have a lawyer review `public/terms.html`, and check your local rules on payments and synthetic media.
- Metering limitation: a Decart session continues for as long as the browser keeps it open, even after a client token expires. The server stops issuing tokens and credits when balance hits zero, but a tampered browser could keep streaming. Ask Decart about server-side session control before heavy public use.

## Run
Copy `.env.example` to `.env`, fill it in, then `npm install && npm start`.
Payment webhook URL to set in NOWPayments: `<PUBLIC_URL>/api/ipn/nowpayments`.
Add a second gateway in `payments.js` by implementing `createInvoice` and `verifyWebhook`.
