// Pantalla de gestión de usuarios del sistema. Se monta después del
// middleware requireAuth, así que ya queda protegida sin nada extra acá.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { crearUsuario, cambiarPassword } = require('../lib/auth');

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'select id, username, nombre, activo, created_at from usuarios order by username'
  );
  res.render('usuarios/lista', { usuarios: rows });
});

router.get('/nuevo', (req, res) => {
  res.render('usuarios/nuevo', { error: null, valores: {} });
});

router.post('/nuevo', async (req, res) => {
  const { username, password, password2, nombre } = req.body;
  try {
    if (!username || !username.trim()) throw new Error('Falta el nombre de usuario.');
    if (!password || password.length < 6) throw new Error('La contraseña tiene que tener al menos 6 caracteres.');
    if (password !== password2) throw new Error('Las contraseñas no coinciden.');
    await crearUsuario({ username, password, nombre });
    res.redirect('/usuarios');
  } catch (err) {
    const msg = /unique/i.test(err.message) ? 'Ese usuario ya existe.' : err.message;
    res.render('usuarios/nuevo', { error: msg, valores: { username, nombre } });
  }
});

router.post('/:id/estado', async (req, res) => {
  // permite desactivar (o reactivar) un usuario sin borrarlo, para no
  // perder el historial de qué usuario hizo cada cosa más adelante
  await pool.query('update usuarios set activo = not activo where id = $1', [req.params.id]);
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
