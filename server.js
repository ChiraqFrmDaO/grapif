const express = require('express');
const dotenv = require('dotenv');
const uaParser = require('ua-parser-js');
const basicAuth = require('express-basic-auth');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.json());

// Database setup with sql.js
let db;
const dbPath = path.join(__dirname, 'ip_logger.db');

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    db.run(`
      CREATE TABLE trackers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracker_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        destination_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    saveDatabase();
  }
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
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

  // Get tracker from database
  const stmt = db.prepare('SELECT destination_url FROM trackers WHERE tracker_id = :trackerId');
  stmt.bind({ ':trackerId': trackerId });
  const tracker = stmt.getAsObject();
  
  if (!tracker || !tracker.destination_url) {
    return res.status(404).send('<h1>❌ Tracker niet gevonden</h1>');
  }

  const destinationUrl = tracker.destination_url;

  try {
    const parser = uaParser(userAgent);

    let geo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org`);
      geo = await geoRes.json();
    } catch (e) {}

    // Insert log into database
    const insertLog = db.prepare(`
      INSERT INTO logs (tracker_id, ip, country, city, isp, browser, os, device, useragent, referer, timestamp)
      VALUES (:trackerId, :ip, :country, :city, :isp, :browser, :os, :device, :useragent, :referer, :timestamp)
    `);
    
    insertLog.run({
      ':trackerId': trackerId,
      ':ip': ip,
      ':country': geo.country || 'Unknown',
      ':city': geo.city || 'Unknown',
      ':isp': geo.isp || 'Unknown',
      ':browser': parser.browser.name || 'Unknown',
      ':os': parser.os.name || 'Unknown',
      ':device': parser.device.type || 'desktop',
      ':useragent': userAgent,
      ':referer': referer,
      ':timestamp': new Date().toISOString()
    });

    saveDatabase();
    console.log(`✅ Gelogd → ${trackerId} | IP: ${ip}`);

  } catch (error) {
    console.error("Error:", error);
  }

  // Redirect
  const html = fs.readFileSync(path.join(__dirname, 'views', 'redirect.html'), 'utf8');
  res.send(html.replace('{{DESTINATION_URL}}', destinationUrl));
});

// ADMIN DASHBOARD
app.get('/admin', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// API: Get all logs
app.get('/api/logs', auth, (req, res) => {
  const stmt = db.prepare('SELECT * FROM logs ORDER BY id DESC');
  const logs = [];
  while (stmt.step()) {
    logs.push(stmt.getAsObject());
  }
  res.json(logs);
});

// API: Get all trackers
app.get('/api/trackers', auth, (req, res) => {
  const stmt = db.prepare('SELECT * FROM trackers ORDER BY id DESC');
  const trackers = [];
  while (stmt.step()) {
    trackers.push(stmt.getAsObject());
  }
  res.json(trackers);
});

// API: Create new tracker
app.post('/api/trackers', auth, (req, res) => {
  const { name, destination_url } = req.body;
  
  if (!name || !destination_url) {
    return res.status(400).json({ error: 'Name and destination_url are required' });
  }

  // Generate unique tracker ID
  const trackerId = crypto.randomBytes(8).toString('hex');
  
  try {
    const insert = db.prepare('INSERT INTO trackers (tracker_id, name, destination_url) VALUES (:trackerId, :name, :destination_url)');
    insert.run({
      ':trackerId': trackerId,
      ':name': name,
      ':destination_url': destination_url
    });
    
    saveDatabase();
    res.json({ tracker_id: trackerId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tracker' });
  }
});

// API: Delete tracker
app.delete('/api/trackers/:id', auth, (req, res) => {
  const trackerId = req.params.id;
  
  try {
    const del = db.prepare('DELETE FROM trackers WHERE tracker_id = :trackerId');
    del.run({ ':trackerId': trackerId });
    
    // Also delete associated logs
    const delLogs = db.prepare('DELETE FROM logs WHERE tracker_id = :trackerId');
    delLogs.run({ ':trackerId': trackerId });
    
    saveDatabase();
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
