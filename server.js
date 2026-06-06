const express = require('express');
const dotenv = require('dotenv');
const uaParser = require('ua-parser-js');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const auth = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'change_me' },
  challenge: true
});

const TRACKERS_FILE = path.join(__dirname, 'trackers.json');
const LOG_FILE = path.join(__dirname, 'logs.txt');
const DEFAULT_REDIRECT_URL = process.env.DEFAULT_REDIRECT_URL || 'https://youtube.com';
const MAX_LOG_ROWS = 500;

let pool = null;
let useDb = false;

function getClientIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
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

  return botKeywords.some(keyword => ua.includes(keyword));
}

function isBotLog(log) {
  return isBotUserAgent(log.useragent) || isBotUserAgent(log.browser) || isBotUserAgent(log.os);
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ Geen DATABASE_URL gevonden, gebruik fallback file storage.');
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
        tracker_id text PRIMARY KEY,
        name text NOT NULL,
        destination_url text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id serial PRIMARY KEY,
        tracker_id text NOT NULL,
        tracker_name text,
        timestamp timestamptz NOT NULL DEFAULT now(),
        ip text,
        country text,
        city text,
        isp text,
        browser text,
        os text,
        device text,
        useragent text,
        referer text,
        latitude numeric,
        longitude numeric,
        is_pixel boolean DEFAULT false
      );
    `);
    useDb = true;
    console.log('? Postgres connectie actief. Opslag via database.');
  } catch (error) {
    console.error('? Database connectie mislukt. Gebruik fallback file storage.', error.message);
    pool = null;
    useDb = false;
  }
}

async function readTrackersFile() {
  if (!fs.existsSync(TRACKERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TRACKERS_FILE, 'utf8'));
  } catch (error) {
    console.error('Fout bij lezen trackers.json:', error);
    return [];
  }
}

async function writeTrackersFile(trackers) {
  fs.writeFileSync(TRACKERS_FILE, JSON.stringify(trackers, null, 2));
}

async function loadTrackers() {
  if (useDb) {
    const { rows } = await pool.query('SELECT tracker_id, name, destination_url, created_at, updated_at FROM trackers ORDER BY created_at DESC');
    return rows;
  }
  return readTrackersFile();
}

async function loadTrackerById(trackerId) {
  if (useDb) {
    const { rows } = await pool.query('SELECT tracker_id, name, destination_url FROM trackers WHERE tracker_id = $1', [trackerId]);
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
        name = EXCLUDED.name,
        destination_url = EXCLUDED.destination_url,
        updated_at = now();
    `, [tracker_id, name, destination_url]);
    return;
  }

  const trackers = await readTrackersFile();
  const existingIndex = trackers.findIndex(t => t.tracker_id === tracker_id);
  if (existingIndex >= 0) {
    trackers[existingIndex] = { tracker_id, name, destination_url, created_at: trackers[existingIndex].created_at, updated_at: new Date().toISOString() };
  } else {
    trackers.push({ tracker_id, name, destination_url, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  writeTrackersFile(trackers);
}

async function deleteTrackerById(trackerId) {
  if (useDb) {
    await pool.query('DELETE FROM logs WHERE tracker_id = $1', [trackerId]);
    await pool.query('DELETE FROM trackers WHERE tracker_id = $1', [trackerId]);
    return;
  }

  const trackers = await readTrackersFile();
  const filteredTrackers = trackers.filter(t => t.tracker_id !== trackerId);
  if (filteredTrackers.length !== trackers.length) {
    writeTrackersFile(filteredTrackers);
  }

  if (!fs.existsSync(LOG_FILE)) return;
  const rawLogs = fs.readFileSync(LOG_FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter(log => log.tracker_id !== trackerId);

  fs.writeFileSync(LOG_FILE, rawLogs.map(log => JSON.stringify(log)).join('\n') + (rawLogs.length ? '\n' : ''));
}

async function appendLog(log) {
  if (useDb) {
    await pool.query(`
      INSERT INTO logs
      (tracker_id, tracker_name, timestamp, ip, country, city, isp, browser, os, device, useragent, referer, latitude, longitude, is_pixel)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      log.tracker_id,
      log.tracker_name,
      log.timestamp,
      log.ip,
      log.country,
      log.city,
      log.isp,
      log.browser,
      log.os,
      log.device,
      log.useragent,
      log.referer,
      log.latitude,
      log.longitude,
      log.is_pixel || false
    ]);
    return;
  }

  fs.appendFileSync(LOG_FILE, JSON.stringify(log) + '\n');
}

async function getLogs(limit = MAX_LOG_ROWS) {
  if (useDb) {
    const query = limit > 0
      ? 'SELECT * FROM logs ORDER BY timestamp DESC LIMIT $1'
      : 'SELECT * FROM logs ORDER BY timestamp DESC';
    const { rows } = limit > 0 ? await pool.query(query, [limit]) : await pool.query(query);
    return rows.filter(row => !isBotLog(row));
  }

  if (!fs.existsSync(LOG_FILE)) return [];
  const rawLogs = fs.readFileSync(LOG_FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter(log => !isBotLog(log));

  return limit > 0 ? rawLogs.slice(-limit).reverse() : rawLogs.reverse();
}

async function getSummary() {
  if (useDb) {
    const trackerCount = await pool.query('SELECT COUNT(*) FROM trackers');
    const logs = await getLogs(0);
    const uniqueIps = new Set(logs.map(l => l.ip).filter(Boolean));
    return {
      totalTrackers: parseInt(trackerCount.rows[0].count, 10),
      totalVisits: logs.length,
      uniqueVisits: uniqueIps.size
    };
  }

  const trackers = await readTrackersFile();
  const logs = await getLogs();
  const uniqueIps = new Set(logs.map(l => l.ip).filter(Boolean));
  return {
    totalTrackers: trackers.length,
    totalVisits: logs.length,
    uniqueVisits: uniqueIps.size
  };
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="nl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ShadowTrack</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        body { margin:0; padding:0; font-family:'Inter',sans-serif; background:linear-gradient(135deg,#0a0a0a,#1a0033); color:white; height:100vh; display:flex; align-items:center; justify-content:center; overflow:hidden; }
        .container { text-align:center; z-index:2; }
        h1 { font-size:4.5rem; margin:0; background:linear-gradient(90deg,#00ff88,#00ccff); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .subtitle { font-size:1.4rem; margin:20px 0 40px; opacity:0.9; }
        .btn { display:inline-block; padding:16px 40px; font-size:1.2rem; background:#00ff88; color:black; text-decoration:none; border-radius:50px; font-weight:700; box-shadow:0 10px 30px rgba(0,255,136,0.4); }
        .btn:hover { transform:translateY(-5px); box-shadow:0 15px 40px rgba(0,255,136,0.6); }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>SHADOWTRACK</h1>
        <p class="subtitle">Geavanceerde IP Tracking & Analytics</p>
        <a href="/admin" class="btn">OPEN DASHBOARD →</a>
      </div>
    </body>
    </html>
  `);
});

async function handleTrackerRedirect(trackerId, res) {
  let destinationUrl = DEFAULT_REDIRECT_URL;
  try {
    const tracker = await loadTrackerById(trackerId);
    if (tracker && tracker.destination_url) {
      destinationUrl = tracker.destination_url;
      console.log(`✅ Bestemming gevonden: ${destinationUrl}`);
    } else {
      console.log(`⚠️ Geen bestemming gevonden voor tracker: ${trackerId}`);
    }
  } catch (error) {
    console.error('Fout bij ophalen tracker:', error);
  }

  console.log(`🔄 Redirect naar: ${destinationUrl}`);

  let html = fs.readFileSync(path.join(__dirname, 'views', 'redirect.html'), 'utf8');
  html = html.replace('{{DESTINATION_URL}}', destinationUrl).replace('{{TRACKER_ID}}', trackerId);
  res.send(html);
}

app.get('/track/:id', async (req, res) => {
  await handleTrackerRedirect(req.params.id, res);
});

app.get('/pixel/:trackerId.png', async (req, res) => {
  try {
    const tracker = await loadTrackerById(req.params.trackerId);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    if (isBotUserAgent(userAgent)) {
      console.log('🚫 Bot pixel ignored:', userAgent);
    } else {
      const parser = uaParser(userAgent);
      const log = {
        timestamp: new Date().toISOString(),
        tracker_id: req.params.trackerId,
        tracker_name: tracker?.name || 'Onbekend',
        ip: getClientIp(req),
        country: 'Unknown',
        city: 'Unknown',
        isp: 'Unknown',
        browser: parser.browser.name || 'Unknown',
        os: parser.os.name || 'Unknown',
        device: parser.device.type || 'desktop',
        useragent: userAgent,
        referer: req.headers.referer || 'None',
        latitude: null,
        longitude: null,
        is_pixel: true
      };
      await appendLog(log);
    }
  } catch (error) {
    console.error('Pixel logging error:', error);
  }

  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAn8B9q7xVQAAAABJRU5ErkJggg==', 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(pixel);
});

app.post('/api/log-geo', async (req, res) => {
  const { tracker_id, ip: clientIp, country, city, isp, lat, lon } = req.body;
  if (!tracker_id) return res.status(400).json({ error: 'No tracker_id' });

  try {
    const userAgent = req.headers['user-agent'] || 'Unknown';
    if (isBotUserAgent(userAgent)) {
      console.log('🚫 Bot geo log ignored:', userAgent);
      return res.json({ success: true });
    }

    const parser = uaParser(userAgent);
    const tracker = await loadTrackerById(tracker_id);

    const log = {
      timestamp: new Date().toISOString(),
      tracker_id,
      tracker_name: tracker?.name || 'Onbekend',
      ip: clientIp || getClientIp(req),
      country: country || 'Unknown',
      city: city || 'Unknown',
      isp: isp || 'Unknown',
      browser: parser.browser.name || 'Unknown',
      os: parser.os.name || 'Unknown',
      device: parser.device.type || 'desktop',
      useragent: userAgent,
      referer: req.headers.referer || 'Direct',
      latitude: lat || null,
      longitude: lon || null,
      is_pixel: false
    };
    await appendLog(log);
    console.log(`📍 Log opgeslagen → ${log.tracker_name} | ${log.country} - ${log.city}`);

    res.json({ success: true });
  } catch (error) {
    console.error('Geo save error:', error);
    res.status(500).json({ error: 'Save failed' });
  }
});

app.post('/api/save-tracker', auth, async (req, res) => {
  const { tracker_id, name, destination_url } = req.body;
  if (!tracker_id || !name || !destination_url) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await saveTracker({ tracker_id, name, destination_url });
    console.log(`? Tracker opgeslagen: ${tracker_id}`);
    res.json({ success: true, tracker_id, link: `/${tracker_id}` });
  } catch (error) {
    console.error('Save tracker error:', error);
    res.status(500).json({ error: 'Save failed' });
  }
});

app.get('/api/trackers', auth, async (req, res) => {
  try {
    const trackers = await loadTrackers();
    res.json(trackers);
  } catch (error) {
    console.error('Load trackers error:', error);
    res.status(500).json({ error: 'Load failed' });
  }
});

app.post('/api/delete-tracker', auth, async (req, res) => {
  const { tracker_id } = req.body;
  if (!tracker_id) {
    return res.status(400).json({ error: 'Missing tracker_id' });
  }

  try {
    await deleteTrackerById(tracker_id);
    console.log(`🗑️ Tracker verwijderd: ${tracker_id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete tracker error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/api/summary', auth, async (req, res) => {
  try {
    const summary = await getSummary();
    res.json(summary);
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: 'Summary failed' });
  }
});

app.get('/admin', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/api/logs', auth, async (req, res) => {
  try {
    const logs = await getLogs();
    if (!useDb) {
      const trackers = await readTrackersFile();
      const trackerMap = trackers.reduce((acc, tracker) => {
        acc[tracker.tracker_id] = tracker;
        return acc;
      }, {});
      return res.json(logs.map(log => ({
        ...log,
        name: log.tracker_name || trackerMap[log.tracker_id]?.name || 'Onbekend'
      })));
    }

    res.json(logs.map(log => ({
      ...log,
      name: log.tracker_name || 'Onbekend'
    })));
  } catch (error) {
    console.error('Load logs error:', error);
    res.status(500).json({ error: 'Load failed' });
  }
});

app.get('/:trackerId', async (req, res, next) => {
  const reserved = ['api', 'admin', 'favicon.ico', 'pixel'];
  const trackerId = req.params.trackerId;
  if (reserved.includes(trackerId.toLowerCase())) {
    return next();
  }
  await handleTrackerRedirect(trackerId, res);
});

const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`? IP Logger draait op poort ${PORT}`);
  });
});
