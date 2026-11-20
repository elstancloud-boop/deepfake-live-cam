import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
export const q = (text, params) => pool.query(text, params);
export async function init() {
  await q(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
    seconds INT NOT NULL DEFAULT 0, banned BOOLEAN NOT NULL DEFAULT FALSE,
    age18_at TIMESTAMPTZ NOT NULL, tos_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS consents(
    id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), photo_sha256 TEXT NOT NULL,
    ip TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS orders(
    id UUID PRIMARY KEY, user_id INT REFERENCES users(id), minutes INT NOT NULL, usd NUMERIC NOT NULL,
    provider TEXT NOT NULL, provider_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS sessions(
    id UUID PRIMARY KEY, user_id INT REFERENCES users(id), consent_id INT REFERENCES consents(id),
    fast BOOLEAN NOT NULL DEFAULT FALSE, started_at TIMESTAMPTZ DEFAULT now(),
    last_beat TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ, seconds_billed INT NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS reports(
    id SERIAL PRIMARY KEY, user_id INT, reason TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  `);
}
