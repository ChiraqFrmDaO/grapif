# IP Logger

Een eenvoudige IP tracking applicatie met Node.js en PostgreSQL.

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

## Gebruik

1. Ga naar `http://localhost:3000/admin`
2. Log in met de credentials uit je `.env` bestand
3. Maak tracking links aan met een naam en doel URL
4. Deel de tracking link en bekijk de logs in het dashboard

## Features

- 🎯 Maak tracking links aan met custom bestemmingen
- 📊 Bekijk IP adres, locatie, browser en OS van bezoekers
- 🔐 Beveiligd dashboard met basic auth
- 💾 PostgreSQL database voor data opslag
- 🗑️ Verwijder trackers en bijbehorende logs

## Environment Variables

- `PORT`: Server poort (default: 3000)
- `ADMIN_USER`: Gebruikersnaam voor dashboard
- `ADMIN_PASS`: Wachtwoord voor dashboard
- `DATABASE_URL`: PostgreSQL connection string