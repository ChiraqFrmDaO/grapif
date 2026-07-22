# IP Logger

Een professionele IP tracking applicatie met Node.js en PostgreSQL.

## Installatie

1. Installeer Node.js: https://nodejs.org/en/download
2. Clone deze repository
3. Kopieer `.env.example` naar `.env` en pas de waarden aan:
   ```
   cp .env.example .env
   ```
4. Installeer dependencies:
   ```
   npm install
   ```
5. Start de server:
   ```
   npm start
   ```

## Deploy op Render

1. Push code naar GitHub
2. Maak een nieuwe PostgreSQL database aan in Render
3. Maak een nieuwe Web Service aan in Render
4. Voeg environment variables toe:
   - `ADMIN_USER`: Je gebruikersnaam
   - `ADMIN_PASS`: Je wachtwoord
   - `DATABASE_URL`: PostgreSQL connection string (automatisch toegevoegd door Render)
   - `SESSION_SECRET`: Een willekeurige string voor sessie encryptie
   - `ALLOWED_ORIGINS`: Comma-gescheiden lijst van toegestane origins (optioneel)

## Gebruik

1. Ga naar `http://localhost:3000/admin`
2. Log in met de credentials uit je `.env` bestand
3. Maak tracking links aan met een naam en doel URL
4. Deel de tracking link en bekijk de logs in het dashboard

## Features

- 🎯 Maak tracking links aan met custom bestemmingen
- 📊 Bekijk IP adres, locatie, browser en OS van bezoekers
- �️ Geolocatie met kaartweergave
- 🔐 Session-based authenticatie met rate limiting
- 💾 PostgreSQL database met connection pooling
- �️ Security headers (Helmet)
- 📈 Health check endpoint
- 🚀 Graceful shutdown
- 📝 Request logging en tracking
- 🌐 CORS support
- 💾 Gzip compression
- ✅ Input validation met Joi
- 🎨 Moderne UI met dark theme

## Environment Variables

- `PORT`: Server poort (default: 3000)
- `ADMIN_USER`: Gebruikersnaam voor dashboard
- `ADMIN_PASS`: Wachtwoord voor dashboard
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Secret voor sessie encryptie
- `DB_SSL`: SSL configuratie voor database (default: auto-detect)
- `ALLOWED_ORIGINS`: CORS toegestane origins (default: *)
- `NODE_ENV`: Environment (development/production)

## API Endpoints

- `GET /` - Homepagina
- `GET /health` - Health check
- `GET /login` - Login pagina
- `POST /api/login` - Login endpoint
- `POST /api/logout` - Logout endpoint
- `GET /admin` - Admin dashboard (vereist authenticatie)
- `GET /api/trackers` - Lijst van trackers (vereist authenticatie)
- `POST /api/save-tracker` - Maak of update tracker (vereist authenticatie)
- `POST /api/delete-tracker` - Verwijder tracker (vereist authenticatie)
- `GET /api/logs` - Lijst van logs (vereist authenticatie)
- `GET /api/summary` - Statistieken (vereist authenticatie)
- `POST /api/log-geo` - Client-side geo logging
- `GET /:trackerId` - Tracker redirect
- `GET /track/:id` - Tracker redirect
- `GET /pixel/:trackerId.png` - Tracking pixel

## Beveiliging

- Rate limiting op auth endpoints
- Bot filtering op tracking endpoints
- XSS preventie met HTML escaping
- CSRF bescherming via sameSite cookies
- SQL injection preventie via parameterized queries
- Content Security Policy via Helmet