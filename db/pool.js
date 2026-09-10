const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[ruta-fria] Falta DATABASE_URL — configurá .env en local, o la variable la pone Render en producción.');
}

// Render exige SSL para conectarse a su Postgres administrado desde el web service;
// en local (sin sslmode) no hace falta.
const useSsl = /render\.com|sslmode=require/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
