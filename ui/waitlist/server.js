require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Add it to your environment (.env).');
  process.exit(1);
}

// Most hosted Postgres (Supabase / Neon / Railway / Render) require SSL.
// For a local, non-SSL Postgres set PGSSL=disable.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id          SERIAL PRIMARY KEY,
      contact     TEXT NOT NULL UNIQUE,
      type        TEXT NOT NULL,            -- 'email' | 'x'
      referrer    TEXT,
      user_agent  TEXT,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist (created_at);`);
  console.log('✓ waitlist table ready');
}

// classify input as an email or an X/Twitter handle, or reject it
function classify(raw) {
  const v = String(raw || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return { type: 'email', value: v.toLowerCase() };
  }
  const handle = v.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) {       // Twitter handle rules
    return { type: 'x', value: '@' + handle.toLowerCase() };
  }
  return null;
}

app.set('trust proxy', 1);                 // correct client IP behind a proxy (Railway/Render/nginx)
app.use(express.json({ limit: '8kb' }));
app.use(cors());                            // safe to keep even if frontend is same-origin
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

app.post('/api/waitlist', limiter, async (req, res) => {
  try {
    const { contact } = req.body || {};
    if (typeof contact !== 'string' || contact.length > 120) {
      return res.status(400).json({ ok: false, error: 'invalid input' });
    }
    const c = classify(contact);
    if (!c) return res.status(400).json({ ok: false, error: 'enter a valid email or @handle' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const ref = String(req.headers['referer'] || '').slice(0, 300);

    const r = await pool.query(
      `INSERT INTO waitlist (contact, type, referrer, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contact) DO NOTHING
       RETURNING id`,
      [c.value, c.type, ref, ua, ip]
    );

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM waitlist');
    const total = rows[0].n;

    return res.json({ ok: true, already: r.rowCount === 0, total });
  } catch (e) {
    console.error('waitlist insert error:', e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

app.get('/api/waitlist/count', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM waitlist');
    res.json({ ok: true, total: rows[0].n });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

init()
  .then(() => app.listen(PORT, () => console.log(`🌒 shade waitlist running on :${PORT}`)))
  .catch((e) => { console.error('init failed:', e.message); process.exit(1); });