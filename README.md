# Deepfake Live Cam: paid edition

Live face swap (Decart Lucy 2.6) with optional approved-voice conversion (ElevenLabs Voice Changer, chunked, several seconds of delay), accounts, required consent, prepaid minutes, crypto checkout (NOWPayments) and an admin dashboard at `/admin/`.

## Safeguards (do not remove)
- 18+ and terms at sign-up; three consent boxes before every session; consent logged with photo hash and IP.
- Decart's AI watermark stays on the video. Voice sessions show a permanent "AI VOICE ACTIVE" banner.
- Voices: only voices an admin adds can be used. There is no user-side voice cloning. Add only voices you own or are licensed to use.
- Abuse report button, admin ban, kill-session and audit log.

## Security
Helmet with strict CSP and HSTS, SameSite=Strict HttpOnly cookies, CSRF header plus origin check, revocable login sessions in the database, bcrypt (cost 12), login lockout after 5 failures, constant-time login, per-IP rate limits, raw card-free payments with signed webhook verification and idempotent crediting, optional admin IP allowlist, admin audit log. Not included: 2FA for admins, a WAF, formal penetration test.

## Run
Copy `.env.example` to `.env`, fill it in, `npm install && npm start`. Sign up with an email listed in `ADMIN_EMAILS` to become admin.
Payment webhook: `<PUBLIC_URL>/api/ipn/nowpayments`.

## Known limits
- A modified browser can keep an already-open Decart stream running after balance reaches zero; ask Decart about server-side session control.
- Voice is chunked (about 4 s) and unverified at scale; the ElevenLabs endpoint and model name should be checked against their current docs.
- Confirm Decart and ElevenLabs commercial/reseller terms and have a lawyer review `public/terms.html` before charging anyone.
