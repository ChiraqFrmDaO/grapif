const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const uaParser = require('ua-parser-js');
const basicAuth = require('express-basic-auth');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.json());
app.set('trust proxy', true);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

const auth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true
});

// === ROOT ===
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ IP Logger is actief</h1>
    <p>Server draait correct.</p>
    <hr>
    <p><a href="/admin">👉 Ga naar Admin Dashboard</a></p>
    <p>Test tracker: <a href="/track/test123">http://localhost:3000/track/test123</a></p>
  `);
});

// === TRACKER ===
app.get('/track/:id', async (req, res) => {
  const trackerId = req.params.id;
  let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');

  console.log(`[TRACK] Binnenkomend verzoek - Tracker: ${trackerId} | IP: ${ip}`);

  if (ip === '::1' || ip === '127.0.0.1') {
    ip = '8.8.8.8'; // Gebruik test-IP voor geo lookup
    console.log(`[LOCAL TEST] Locale IP vervangen door test-IP`);
  }

  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers.referer || 'Direct';
  let destinationUrl = "https://youtube.com";

  try {
    const [tracker] = await pool.query('SELECT destination_url FROM trackers WHERE tracker_id = ?', [trackerId]);
    console.log(`[DB] Tracker gevonden:`, tracker);

    if (tracker.length > 0) {
      destinationUrl = tracker[0].destination_url;
    }

    const parser = uaParser(userAgent);

    let geo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org`);
      geo = await geoRes.json();
      console.log(`[GEO] Resultaat:`, geo);
    } catch (e) {
      console.error(`[GEO] Fout bij ophalen geo data:`, e.message);
    }

    const log = {
      tracker_id: trackerId,
      ip: ip,
      country: geo.country || 'Unknown',
      city: geo.city || 'Unknown',
      isp: geo.isp || geo.org || 'Unknown',
      browser: parser.browser.name || 'Unknown',
      os: parser.os.name || 'Unknown',
      device: parser.device.type || 'desktop',
      useragent: userAgent,
      referer: referer,
      timestamp: new Date()
    };

    console.log(`[LOG] Probeer op te slaan:`, log);
    await pool.query('INSERT INTO logs SET ?', log);
    console.log(`[LOG] Succesvol opgeslagen!`);

  } catch (error) {
    console.error("[TRACKER ERROR]", error);
  }

  let html = fs.readFileSync(__dirname + '/views/redirect.html', 'utf8');
  html = html.replace("{{DESTINATION_URL}}", destinationUrl);
  res.send(html);
});

// === ADMIN ROUTES ===

// Dashboard
app.get('/admin', auth, (req, res) => {
  res.sendFile(__dirname + '/views/admin.html');
});

// API: Alle logs ophalen
app.get('/api/logs', auth, async (req, res) => {
  const [logs] = await pool.query('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 1000');
  res.json(logs);
});

// API: Alle trackers ophalen
app.get('/api/trackers', auth, async (req, res) => {
  const [trackers] = await pool.query('SELECT * FROM trackers ORDER BY created_at DESC');
  res.json(trackers);
});

// API: Nieuwe tracker aanmaken
app.post('/api/trackers', auth, async (req, res) => {
  const { name, destination_url } = req.body;
  const tracker_id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  await pool.query(
    'INSERT INTO trackers (tracker_id, name, destination_url) VALUES (?, ?, ?)',
    [tracker_id, name, destination_url]
  );

  res.json({ success: true, tracker_id, link: `/track/${tracker_id}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ IP Logger actief op http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});