// Login con usuario y contraseña. Las contraseñas se guardan siempre como
// hash (bcrypt), nunca en texto plano.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

async function contarUsuarios() {
  const { rows } = await pool.query('select count(*)::int as n from usuarios');
  return rows[0].n;
}

async function buscarPorUsername(username) {
  const { rows } = await pool.query(
    'select * from usuarios where username = $1 and activo = true',
    [username]
  );
  return rows[0] || null;
}

async function crearUsuario({ username, password, nombre }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into usuarios (username, password_hash, nombre)
     values ($1, $2, $3)
     returning id, username, nombre, activo, created_at`,
    [String(username).trim(), hash, nombre ? String(nombre).trim() : null]
  );
  return rows[0];
}

async function cambiarPassword(id, password) {
  const hash = await bcrypt.hash(password, 10);
  await pool.query('update usuarios set password_hash = $1 where id = $2', [hash, id]);
}

async function verificarPassword(usuario, password) {
  return bcrypt.compare(String(password || ''), usuario.password_hash);
}

// Protege todas las rutas que se registren después de este middleware.
// Si no hay ningún usuario creado todavía, manda al asistente de
// configuración inicial en vez de a una pantalla de login sin salida.
async function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  try {
    const n = await contarUsuarios();
    if (n === 0) return res.redirect('/setup');
  } catch (err) {
    console.error('[ruta-fria] error chequeando usuarios:', err.message);
  }
  return res.redirect('/login');
}

module.exports = {
  contarUsuarios,
  buscarPorUsername,
  crearUsuario,
  cambiarPassword,
  verificarPassword,
  requireAuth,
};
