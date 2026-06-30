import express from 'express';
import { neon } from '@neondatabase/serverless';
import { randomInt } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);

// Routes are kept for 48 hours. Expiry is enforced on read (see GET /import);
// expired rows are intentionally left in the database (no cleanup job).
const TTL_HOURS = 48;

// --- one-time schema setup (runs at most once per warm instance) ---
let schemaReady;
function ensureSchema() {
  schemaReady ??= sql`
    CREATE TABLE IF NOT EXISTS shared_routes (
      code        text PRIMARY KEY,
      name        text NOT NULL,
      route_json  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
  return schemaReady;
}

// --- code generation: 8 chars, uppercase letters + digits ---
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function generateCode(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// POST /share -> stores the route, returns { code }
app.post('/share', async (req, res) => {
  try {
    const body = req.body;

    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (!Array.isArray(body.points) || body.points.length < 2) {
      return res.status(400).json({ error: 'points is required and must have at least 2 entries.' });
    }

    await ensureSchema();

    // Retry on the (extremely unlikely) primary-key collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await sql`
          INSERT INTO shared_routes (code, name, route_json)
          VALUES (${code}, ${body.name}, ${JSON.stringify(body)})
        `;
        return res.json({ code });
      } catch (e) {
        if (e?.code === '23505') continue; // unique_violation -> try a new code
        throw e;
      }
    }
    return res.status(500).json({ error: 'Could not allocate a share code.' });
  } catch (e) {
    console.error('POST /share failed:', e);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

// GET /import?code=... -> the stored route JSON, or 404 / 410
app.get('/import', async (req, res) => {
  try {
    const code = req.query.code;
    if (typeof code !== 'string' || code === '') {
      return res.status(400).json({ error: 'code query parameter is required.' });
    }

    await ensureSchema();

    const rows = await sql`
      SELECT route_json,
             created_at < now() - make_interval(hours => ${TTL_HOURS}) AS expired
      FROM shared_routes
      WHERE code = ${code}
    `;
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.expired) return res.status(410).json({ error: 'This share has expired.' });

    // route_json is the full original POST body stored verbatim; segments is
    // naturally absent when it was not provided, so it is omitted as required.
    return res.type('application/json').send(row.route_json);
  } catch (e) {
    console.error('GET /import failed:', e);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

export default app;
