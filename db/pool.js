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
  // Fija el huso horario de cada sesión de Postgres a la hora de
  // Argentina desde que se abre la conexión (vía el parámetro de
  // arranque de libpq, no una query aparte) — así "fecha::date",
  // extract(...) y to_char(date_trunc(...)) en cualquier consulta del
  // sistema calculan el día y la hora como los vive el negocio, sin
  // importar que el server (Render) corra en UTC.
  options: '-c TimeZone=America/Argentina/Buenos_Aires',
});

module.exports = pool;
