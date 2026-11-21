import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false },
});
export const q = (text, params) => pool.query(text, params);
export async function init() {
  await q(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', seconds INT NOT NULL DEFAULT 0, banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT, failed_logins INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ,
    age18_at TIMESTAMPTZ NOT NULL, tos_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS auth_sessions(
    id UUID PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT, ua TEXT, created_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN DEFAULT FALSE);
  CREATE TABLE IF NOT EXISTS consents(
    id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), photo_sha256 TEXT NOT NULL,
    voice_id TEXT, ip TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS orders(
    id UUID PRIMARY KEY, user_id INT REFERENCES users(id), minutes INT NOT NULL, usd NUMERIC NOT NULL,
    provider TEXT NOT NULL, provider_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS sessions(
    id UUID PRIMARY KEY, user_id INT REFERENCES users(id), consent_id INT REFERENCES consents(id),
    fast BOOLEAN NOT NULL DEFAULT FALSE, voice BOOLEAN NOT NULL DEFAULT FALSE, started_at TIMESTAMPTZ DEFAULT now(),
    last_beat TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ, seconds_billed INT NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS voices(
    id SERIAL PRIMARY KEY, label TEXT NOT NULL, eleven_voice_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE);
  CREATE TABLE IF NOT EXISTS reports(
    id SERIAL PRIMARY KEY, user_id INT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS audit_log(
    id SERIAL PRIMARY KEY, admin_id INT, action TEXT NOT NULL, target TEXT, detail JSONB, ip TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, started_at DESC);
  `);
}
