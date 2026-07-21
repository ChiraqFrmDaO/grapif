# IP Logger

Een eenvoudige IP tracking applicatie met Node.js en SQLite.

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

## Gebruik

1. Ga naar `http://localhost:3000/admin`
2. Log in met de credentials uit je `.env` bestand
3. Maak tracking links aan met een naam en doel URL
4. Deel de tracking link en bekijk de logs in het dashboard

## Features

- 🎯 Maak tracking links aan met custom bestemmingen
- 📊 Bekijk IP adres, locatie, browser en OS van bezoekers
- 🔐 Beveiligd dashboard met basic auth
- 💾 SQLite database voor data opslag
- 🗑️ Verwijder trackers en bijbehorende logs

## Environment Variables

- `PORT`: Server poort (default: 3000)
- `ADMIN_USER`: Gebruikersnaam voor dashboard
- `ADMIN_PASS`: Wachtwoord voor dashboard