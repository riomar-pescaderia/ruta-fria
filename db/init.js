// Ejecuta db/schema.sql contra la base configurada en DATABASE_URL.
// Uso: npm run db:init
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[ruta-fria] esquema aplicado correctamente.');
  await pool.end();
}

main().catch((err) => {
  console.error('[ruta-fria] error al aplicar el esquema:', err.message);
  process.exit(1);
});
