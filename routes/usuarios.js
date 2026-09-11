// Pantalla de gestión de usuarios del sistema. Se monta con requireAdmin
// en server.js, así que solo un administrador puede entrar acá — nadie
// más ve ni puede tocar esta sección.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { MODULOS, crearUsuario, cambiarPassword, actualizarPermisos, alternarEstado } = require('../lib/auth');

function leerAccesos(body) {
  const accesos = {};
  MODULOS.forEach((m) => { accesos[m] = body[`acceso_${m}`] === 'on'; });
  return accesos;
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `select id, username, nombre, activo, es_admin,
            acceso_clientes, acceso_articulos, acceso_compras, acceso_gastos, acceso_ventas
     from usuarios order by username`
  );
  res.render('usuarios/lista', { usuarios: rows, sesionId: req.session.usuario.id, error: req.query.error || null });
});

router.get('/nuevo', (req, res) => {
  res.render('usuarios/nuevo', { error: null, valores: {}, accesos: {} });
});

router.post('/nuevo', async (req, res) => {
  const { username, password, password2, nombre } = req.body;
  const esAdmin = req.body.es_admin === 'on';
  const accesos = leerAccesos(req.body);
  try {
    if (!username || !username.trim()) throw new Error('Falta el nombre de usuario.');
    if (!password || password.length < 6) throw new Error('La contraseña tiene que tener al menos 6 caracteres.');
    if (password !== password2) throw new Error('Las contraseñas no coinciden.');
    await crearUsuario({ username, password, nombre, esAdmin, accesos });
    res.redirect('/usuarios');
  } catch (err) {
    const msg = /unique/i.test(err.message) ? 'Ese usuario ya existe.' : err.message;
    res.render('usuarios/nuevo', { error: msg, valores: { username, nombre, es_admin: esAdmin }, accesos });
  }
});

router.post('/:id/estado', async (req, res) => {
  // permite desactivar (o reactivar) un usuario sin borrarlo, para no
  // perder el historial de qué usuario hizo cada cosa más adelante —
  // salvo que sea el último administrador activo
  const r = await alternarEstado(req.params.id);
  if (!r.ok) return res.redirect('/usuarios?error=' + encodeURIComponent(r.error));
  res.redirect('/usuarios');
});

router.get('/:id/permisos', async (req, res) => {
  const { rows } = await pool.query(
    `select id, username, nombre, es_admin,
            acceso_clientes, acceso_articulos, acceso_compras, acceso_gastos, acceso_ventas
     from usuarios where id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.redirect('/usuarios');
  res.render('usuarios/permisos', { usuario: rows[0], error: null });
});

router.post('/:id/permisos', async (req, res) => {
  const esAdmin = req.body.es_admin === 'on';
  const accesos = leerAccesos(req.body);
  const r = await actualizarPermisos(req.params.id, { esAdmin, accesos });
  if (!r.ok) {
    const { rows } = await pool.query(
      `select id, username, nombre, es_admin,
              acceso_clientes, acceso_articulos, acceso_compras, acceso_gastos, acceso_ventas
       from usuarios where id = $1`,
      [req.params.id]
    );
    return res.render('usuarios/permisos', { usuario: rows[0], error: r.error });
  }
  res.redirect('/usuarios');
});

router.get('/:id/password', async (req, res) => {
  const { rows } = await pool.query('select id, username, nombre from usuarios where id = $1', [req.params.id]);
  if (!rows[0]) return res.redirect('/usuarios');
  res.render('usuarios/password', { usuario: rows[0], error: null });
});

router.post('/:id/password', async (req, res) => {
  const { rows } = await pool.query('select id, username, nombre from usuarios where id = $1', [req.params.id]);
  const usuario = rows[0];
  if (!usuario) return res.redirect('/usuarios');
  try {
    const { password, password2 } = req.body;
    if (!password || password.length < 6) throw new Error('La contraseña tiene que tener al menos 6 caracteres.');
    if (password !== password2) throw new Error('Las contraseñas no coinciden.');
    await cambiarPassword(usuario.id, password);
    res.redirect('/usuarios');
  } catch (err) {
    res.render('usuarios/password', { usuario, error: err.message });
  }
});

module.exports = router;
