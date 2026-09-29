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

// Sin este listener, el sistema se cae entero (y no se levanta solo) ante
// cualquier corte de conexión con la base — es un comportamiento
// documentado de la librería "pg": cuando una conexión que estaba
// esperando ociosa en el pool se corta sola (por ejemplo, si Render
// reinicia la base, o hay un corte de red momentáneo), esa conexión
// emite un evento "error" sobre el pool. Si nadie escucha ese evento,
// Node lo trata como una excepción no atrapada y tira abajo todo el
// proceso, en vez de simplemente descartar esa conexión y abrir una
// nueva la próxima vez que haga falta (que es lo que el pool ya hace
// solo, siempre que este error no lo mate antes). Con este listener, el
// corte queda solo en el log — el sistema sigue de pie y la conexión
// siguiente se reestablece sola.
pool.on('error', (err) => {
  console.error('[ruta-fria] error de conexión con la base de datos (conexión ociosa cortada, se reestablece sola):', err.message);
});

module.exports = pool;
