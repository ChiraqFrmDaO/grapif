/**
 * ShadowTrack - server.js (verbeterd)
 *
 * Wijzigingen t.o.v. origineel:
 *  - helmet toegevoegd voor security-headers (CSP, X-Frame-Options, etc.)
 *  - express-rate-limit op /api/log-geo en pixel-endpoint
 *  - crypto.randomBytes voor tracker-ID's (niet meer Math.random)
 *  - URL-validatie (alleen https://) bij /api/save-tracker
 *  - HTML-escaping in handleTrackerRedirect (voorkomt XSS via template-injection)
 *  - fs.promises gebruikt in plaats van sync-varianten
 *  - getSummary() telt unieke IPs via SQL (schaalt beter)
 *  - Homepagina-HTML verplaatst naar views/index.html
 *  - Reserved-list uitgebreid en ook gecontroleerd bij opslaan van tracker
 */

const express    = require('express');
const dotenv     = require('dotenv');
const uaParser   = require('ua-parser-js');
const session    = require('express-session');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const fsp        = require('fs').promises;
const fs         = require('fs');
const crypto     = require('crypto');
const path       = require('path');
const { Pool }   = require('pg');

dotenv.config();

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdnjs.cloudflare.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', '*.tile.openstreetmap.org', 'https://cdnjs.cloudflare.com'],
      connectSrc:  ["'self'", 'ipapi.co'],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.static('public'));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// ── Session management ────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_me_in_production',
  resave: false,
  saveUninitialized: false,
  name: 'sid',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// ── Authenticatie middleware ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.redirect('/login');
}

// ── Admin credentials ─────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change_me';

if (process.env.ADMIN_USER || process.env.ADMIN_PASS) {
  console.log('🔐 Admin credentials loaded from environment.');
} else {
  console.warn('⚠️ Geen ADMIN_USER/ADMIN_PASS gevonden. Gebruik admin/change_me alleen voor lokale tests.');
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const geoLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuut
  max: 10,               // max 10 log-verzoeken per IP per minuut
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel verzoeken. Probeer later opnieuw.' }
});

const pixelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Constanten ────────────────────────────────────────────────────────────────
const TRACKERS_FILE       = path.join(__dirname, 'trackers.json');
const LOG_FILE            = path.join(__dirname, 'logs.txt');
const DEFAULT_REDIRECT_URL = process.env.DEFAULT_REDIRECT_URL || 'https://youtube.com';
const MAX_LOG_ROWS        = 500;

// Alle paden die nooit een tracker-ID mogen zijn
const RESERVED_IDS = new Set([
  'api', 'admin', 'favicon.ico', 'pixel', 'track',
  'static', 'public', 'health', 'robots.txt', 'sitemap.xml'
]);

let pool   = null;
let useDb  = false;

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

/** Escaped een string zodat hij veilig in een HTML-attribuut of JS-string kan. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;')
    .replace(/\//g, '&#x2F;');
}

/** Veilig voor gebruik binnen een JS-string-literal in een <script>-blok. */
function escapeJs(str) {
  return JSON.stringify(String(str));
}

function getClientIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
  return ip.replace(/^::ffff:/, '') || 'Unknown';
}

function isBotUserAgent(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  if (!ua || ua === 'unknown') return true;
  const botKeywords = [
    'bot', 'crawl', 'spider', 'slurp', 'fetch', 'scanner', 'monitor',
    'python-requests', 'libwww-perl', 'curl', 'wget', 'httpclient', 'okhttp',
    'facebookexternalhit', 'facebot', 'discordbot', 'slackbot', 'telegrambot',
    'ahrefsbot', 'semrushbot', 'mj12bot', 'rogerbot', 'yandex', 'bingpreview',
    'googlebot', 'bingbot', 'baiduspider', 'pinterest', 'preview'
  ];
  return botKeywords.some(kw => ua.includes(kw));
}

function isBotLog(log) {
  return isBotUserAgent(log.useragent) || isBotUserAgent(log.browser) || isBotUserAgent(log.os);
}

/** Valideert dat een URL met https:// begint en een geldig hostname heeft. */
function isValidHttpsUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Genereert een cryptografisch veilig tracker-ID (8 hex-tekens). */
function generateTrackerId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── Database-initialisatie ────────────────────────────────────────────────────
async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️  Geen DATABASE_URL gevonden, gebruik fallback file storage.');
    return;
  }

  const config = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  };

  try {
    pool = new Pool(config);
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trackers (
        tracker_id    text        PRIMARY KEY,
        name          text        NOT NULL,
        destination_url text      NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id            serial      PRIMARY KEY,
        tracker_id    text        NOT NULL,
        tracker_name  text,
        timestamp     timestamptz NOT NULL DEFAULT now(),
        ip            text,
        country       text,
        city          text,
        isp           text,
        browser       text,
        os            text,
        device        text,
        useragent     text,
        referer       text,
        latitude      numeric,
        longitude     numeric,
        is_pixel      boolean     DEFAULT false
      );
    `);
    useDb = true;
    console.log('✅ Postgres connectie actief. Opslag via database.');
  } catch (error) {
    console.error('❌ Database connectie mislukt. Gebruik fallback file storage.', error.message);
    pool  = null;
    useDb = false;
  }
}

// ── File-storage helpers (async) ──────────────────────────────────────────────
async function readTrackersFile() {
  try {
    const data = await fsp.readFile(TRACKERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeTrackersFile(trackers) {
  await fsp.writeFile(TRACKERS_FILE, JSON.stringify(trackers, null, 2));
}

// ── Data-toegang ──────────────────────────────────────────────────────────────
async function loadTrackers() {
  if (useDb) {
    const { rows } = await pool.query(
      'SELECT tracker_id, name, destination_url, created_at, updated_at FROM trackers ORDER BY created_at DESC'
    );
    return rows;
  }
  return readTrackersFile();
}

async function loadTrackerById(trackerId) {
  if (useDb) {
    const { rows } = await pool.query(
      'SELECT tracker_id, name, destination_url FROM trackers WHERE tracker_id = $1',
      [trackerId]
    );
    return rows[0];
  }
  const trackers = await readTrackersFile();
  return trackers.find(t => t.tracker_id === trackerId);
}

async function saveTracker({ tracker_id, name, destination_url }) {
  if (useDb) {
    await pool.query(`
      INSERT INTO trackers (tracker_id, name, destination_url, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now())
      ON CONFLICT (tracker_id) DO UPDATE SET
        name            = EXCLUDED.name,
        destination_url = EXCLUDED.destination_url,
        updated_at      = now();
    `, [tracker_id, name, destination_url]);
    return;
  }

  const trackers    = await readTrackersFile();
  const existingIdx = trackers.findIndex(t => t.tracker_id === tracker_id);
  const now         = new Date().toISOString();

  if (existingIdx >= 0) {
    trackers[existingIdx] = {
      ...trackers[existingIdx],
      name,
      destination_url,
      updated_at: now
    };
  } else {
    trackers.push({ tracker_id, name, destination_url, created_at: now, updated_at: now });
  }
  await writeTrackersFile(trackers);
}

async function deleteTrackerById(trackerId) {
  if (useDb) {
    await pool.query('DELETE FROM logs     WHERE tracker_id = $1', [trackerId]);
    await pool.query('DELETE FROM trackers WHERE tracker_id = $1', [trackerId]);
    return;
  }

  const trackers         = await readTrackersFile();
  const filteredTrackers = trackers.filter(t => t.tracker_id !== trackerId);
  if (filteredTrackers.length !== trackers.length) {
    await writeTrackersFile(filteredTrackers);
  }

  try {
    const rawLogs = (await fsp.readFile(LOG_FILE, 'utf8'))
      .trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter(log => log.tracker_id !== trackerId);
    await fsp.writeFile(
      LOG_FILE,
      rawLogs.map(l => JSON.stringify(l)).join('\n') + (rawLogs.length ? '\n' : '')
    );
  } catch {
    // LOG_FILE bestaat nog niet — geen probleem
  }
}

async function appendLog(log) {
  if (useDb) {
    await pool.query(`
      INSERT INTO logs
        (tracker_id, tracker_name, timestamp, ip, country, city, isp,
         browser, os, device, useragent, referer, latitude, longitude, is_pixel)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      log.tracker_id, log.tracker_name, log.timestamp,
      log.ip, log.country, log.city, log.isp,
      log.browser, log.os, log.device, log.useragent, log.referer,
      log.latitude, log.longitude, log.is_pixel ?? false
    ]);
    return;
  }
  await fsp.appendFile(LOG_FILE, JSON.stringify(log) + '\n');
}

async function getLogs(limit = MAX_LOG_ROWS) {
  if (useDb) {
    const query  = limit > 0
      ? 'SELECT * FROM logs ORDER BY timestamp DESC LIMIT $1'
      : 'SELECT * FROM logs ORDER BY timestamp DESC';
    const { rows } = limit > 0
      ? await pool.query(query, [limit])
      : await pool.query(query);
    return rows.filter(row => !isBotLog(row));
  }

  try {
    const rawLogs = (await fsp.readFile(LOG_FILE, 'utf8'))
      .trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter(log => !isBotLog(log));
    return limit > 0 ? rawLogs.slice(-limit).reverse() : rawLogs.reverse();
  } catch {
    return [];
  }
}

async function getSummary() {
  if (useDb) {
    // Unieke IPs efficiënt via SQL — laadt niet alles in geheugen
    const [trackerRes, visitsRes, uniqueRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM trackers`),
      pool.query(`SELECT COUNT(*) FROM logs WHERE useragent NOT ILIKE '%bot%' AND useragent NOT ILIKE '%crawl%'`),
      pool.query(`SELECT COUNT(DISTINCT ip) FROM logs WHERE useragent NOT ILIKE '%bot%' AND useragent NOT ILIKE '%crawl%'`),
    ]);
    return {
      totalTrackers: parseInt(trackerRes.rows[0].count, 10),
      totalVisits:   parseInt(visitsRes.rows[0].count,   10),
      uniqueVisits:  parseInt(uniqueRes.rows[0].count,   10),
    };
  }

  const trackers   = await readTrackersFile();
  const logs       = await getLogs(0);
  const uniqueIps  = new Set(logs.map(l => l.ip).filter(Boolean));
  return {
    totalTrackers: trackers.length,
    totalVisits:   logs.length,
    uniqueVisits:  uniqueIps.size
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Homepagina uit views/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Redirect-handler met HTML-escaping
async function handleTrackerRedirect(trackerId, res) {
  let destinationUrl = DEFAULT_REDIRECT_URL;
  try {
    const tracker = await loadTrackerById(trackerId);
    if (tracker?.destination_url) {
      destinationUrl = tracker.destination_url;
    }
  } catch (error) {
    console.error('Fout bij ophalen tracker:', error);
  }

  let html = await fsp.readFile(path.join(__dirname, 'views', 'redirect.html'), 'utf8');

  // Veilige injectie: gebruik JSON.stringify voor JS-context
  html = html
    .replace('{{DESTINATION_URL}}', escapeJs(destinationUrl))
    .replace('{{TRACKER_ID}}',      escapeJs(trackerId));

  res.send(html);
}

app.get('/track/:id', async (req, res) => {
  await handleTrackerRedirect(req.params.id, res);
});

// Tracking pixel
app.get('/pixel/:trackerId.png', pixelLimiter, async (req, res) => {
  try {
    const userAgent = req.headers['user-agent'] || 'Unknown';
    if (!isBotUserAgent(userAgent)) {
      const tracker = await loadTrackerById(req.params.trackerId);
      const parser  = uaParser(userAgent);
      await appendLog({
        timestamp:    new Date().toISOString(),
        tracker_id:   req.params.trackerId,
        tracker_name: tracker?.name || 'Onbekend',
        ip:           getClientIp(req),
        country:      'Unknown',
        city:         'Unknown',
        isp:          'Unknown',
        browser:      parser.browser.name || 'Unknown',
        os:           parser.os.name      || 'Unknown',
        device:       parser.device.type  || 'desktop',
        useragent:    userAgent,
        referer:      req.headers.referer || 'None',
        latitude:     null,
        longitude:    null,
        is_pixel:     true
      });
    }
  } catch (error) {
    console.error('Pixel logging error:', error);
  }

  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAn8B9q7xVQAAAABJRU5ErkJggg==',
    'base64'
  );
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(pixel);
});

// Geo-log (client-side geo → server)
app.post('/api/log-geo', geoLimiter, async (req, res) => {
  const { tracker_id, ip: clientIp, country, city, isp, lat, lon } = req.body;
  if (!tracker_id) return res.status(400).json({ error: 'No tracker_id' });

  try {
    const userAgent = req.headers['user-agent'] || 'Unknown';
    if (isBotUserAgent(userAgent)) return res.json({ success: true });

    const parser  = uaParser(userAgent);
    const tracker = await loadTrackerById(tracker_id);

    await appendLog({
      timestamp:    new Date().toISOString(),
      tracker_id,
      tracker_name: tracker?.name || 'Onbekend',
      ip:           clientIp || getClientIp(req),
      country:      country  || 'Unknown',
      city:         city     || 'Unknown',
      isp:          isp      || 'Unknown',
      browser:      parser.browser.name || 'Unknown',
      os:           parser.os.name      || 'Unknown',
      device:       parser.device.type  || 'desktop',
      useragent:    userAgent,
      referer:      req.headers.referer || 'Direct',
      latitude:     lat || null,
      longitude:    lon || null,
      is_pixel:     false
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Geo save error:', error);
    res.status(500).json({ error: 'Save failed' });
  }
});

// Tracker opslaan (met URL-validatie + reserved-ID check)
app.post('/api/save-tracker', requireAuth, async (req, res) => {
  let { tracker_id, name, destination_url } = req.body;

  // Genereer een ID als er geen is opgegeven (admin laat het veld leeg)
  if (!tracker_id) tracker_id = generateTrackerId();

  if (!name || !destination_url) {
    return res.status(400).json({ error: 'Naam en doel-URL zijn verplicht.' });
  }

  // Valideer URL
  if (!isValidHttpsUrl(destination_url)) {
    return res.status(400).json({ error: 'Doel-URL moet beginnen met https://' });
  }

  // Blokkeer reserved IDs
  if (RESERVED_IDS.has(tracker_id.toLowerCase())) {
    return res.status(400).json({ error: 'Dit tracker-ID is gereserveerd.' });
  }

  // Beperk ID-formaat: alleen alfanumeriek + koppelteken, max 32 tekens
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(tracker_id)) {
    return res.status(400).json({ error: 'Ongeldig tracker-ID formaat.' });
  }

  try {
    await saveTracker({ tracker_id, name, destination_url });
    console.log(`✅ Tracker opgeslagen: ${tracker_id}`);
    res.json({ success: true, tracker_id, link: `/${tracker_id}` });
  } catch (error) {
    console.error('Save tracker error:', error);
    res.status(500).json({ error: 'Opslaan mislukt.' });
  }
});

app.get('/api/trackers', requireAuth, async (req, res) => {
  try {
    res.json(await loadTrackers());
  } catch (error) {
    console.error('Load trackers error:', error);
    res.status(500).json({ error: 'Load failed' });
  }
});

app.post('/api/delete-tracker', requireAuth, async (req, res) => {
  const { tracker_id } = req.body;
  if (!tracker_id) return res.status(400).json({ error: 'Missing tracker_id' });

  try {
    await deleteTrackerById(tracker_id);
    console.log(`🗑️  Tracker verwijderd: ${tracker_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete tracker error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    res.json(await getSummary());
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: 'Summary failed' });
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const isJson = req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    req.session.user = username;
    if (isJson) {
      return res.json({ success: true });
    }
    return res.redirect('/admin');
  }

  if (isJson) {
    return res.status(401).json({ error: 'Ongeldige gebruikersnaam of wachtwoord.' });
  }

  res.redirect('/login');
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const logs     = await getLogs();
    const trackers = useDb ? [] : await readTrackersFile();
    const tMap     = trackers.reduce((acc, t) => { acc[t.tracker_id] = t; return acc; }, {});

    res.json(logs.map(log => ({
      ...log,
      name: log.tracker_name || tMap[log.tracker_id]?.name || 'Onbekend'
    })));
  } catch (error) {
    console.error('Load logs error:', error);
    res.status(500).json({ error: 'Load failed' });
  }
});

// Wildcard tracker-redirect (reserved-check ook hier)
app.get('/:trackerId', async (req, res, next) => {
  const trackerId = req.params.trackerId;
  if (RESERVED_IDS.has(trackerId.toLowerCase())) return next();
  await handleTrackerRedirect(trackerId, res);
});

// ── Opstarten ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 ShadowTrack draait op poort ${PORT}`);
  });
});
