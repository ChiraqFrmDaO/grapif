const express = require('express');
const dotenv = require('dotenv');
const uaParser = require('ua-parser-js');
const basicAuth = require('express-basic-auth');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.json());

// PostgreSQL setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trackers (
      id SERIAL PRIMARY KEY,
      tracker_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      tracker_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      country TEXT,
      city TEXT,
      isp TEXT,
      browser TEXT,
      os TEXT,
      device TEXT,
      useragent TEXT,
      referer TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

const auth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true
});

// ROOT
app.get('/', (req, res) => {
  res.send('<h1>✅ IP Logger is Online</h1><p><a href="/admin">→ Ga naar Dashboard</a></p>');
});

// TRACKER
app.get('/track/:id', async (req, res) => {
  const trackerId = req.params.id;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers.referer || 'Direct';

  try {
    // Get tracker from database
    const trackerResult = await pool.query('SELECT destination_url FROM trackers WHERE tracker_id = $1', [trackerId]);
    
    if (!trackerResult.rows[0]) {
      return res.status(404).send('<h1>❌ Tracker niet gevonden</h1>');
    }

    const destinationUrl = trackerResult.rows[0].destination_url;

    const parser = uaParser(userAgent);

    let geo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org`);
      geo = await geoRes.json();
    } catch (e) {}

    // Insert log into database
    await pool.query(
      `INSERT INTO logs (tracker_id, ip, country, city, isp, browser, os, device, useragent, referer, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        trackerId,
        ip,
        geo.country || 'Unknown',
        geo.city || 'Unknown',
        geo.isp || 'Unknown',
        parser.browser.name || 'Unknown',
        parser.os.name || 'Unknown',
        parser.device.type || 'desktop',
        userAgent,
        referer,
        new Date().toISOString()
      ]
    );

    console.log(`✅ Gelogd → ${trackerId} | IP: ${ip}`);

    // Redirect
    const html = fs.readFileSync(path.join(__dirname, 'views', 'redirect.html'), 'utf8');
    res.send(html.replace('{{DESTINATION_URL}}', destinationUrl));

  } catch (error) {
    console.error("Error:", error);
    res.status(500).send('Server error');
  }
});

// ADMIN DASHBOARD
app.get('/admin', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// API: Get all logs
app.get('/api/logs', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logs ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// API: Get all trackers
app.get('/api/trackers', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trackers ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trackers' });
  }
});

// API: Create new tracker
app.post('/api/trackers', auth, async (req, res) => {
  const { name, destination_url } = req.body;
  
  if (!name || !destination_url) {
    return res.status(400).json({ error: 'Name and destination_url are required' });
  }

  const trackerId = crypto.randomBytes(8).toString('hex');
  
  try {
    await pool.query(
      'INSERT INTO trackers (tracker_id, name, destination_url) VALUES ($1, $2, $3)',
      [trackerId, name, destination_url]
    );
    res.json({ tracker_id: trackerId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tracker' });
  }
});

// API: Delete tracker
app.delete('/api/trackers/:id', auth, async (req, res) => {
  const trackerId = req.params.id;
  
  try {
    await pool.query('DELETE FROM trackers WHERE tracker_id = $1', [trackerId]);
    await pool.query('DELETE FROM logs WHERE tracker_id = $1', [trackerId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete tracker' });
  }
});

const PORT = process.env.PORT || 3000;

// Start server after database is initialized
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ IP Logger draait op poort ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
