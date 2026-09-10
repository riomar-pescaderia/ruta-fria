const pool = require('../db/pool');

async function getConfig() {
  const { rows } = await pool.query('select clave, valor from config');
  const config = {};
  for (const row of rows) config[row.clave] = row.valor;
  return config;
}

module.exports = { getConfig };
