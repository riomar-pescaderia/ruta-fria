const express = require('express');
const router = express.Router();
const { contarUsuarios, buscarPorUsername, crearUsuario, verificarPassword } = require('../lib/auth');

router.get('/login', async (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  let n = 0;
  try {
    n = await contarUsuarios();
  } catch (err) {
    console.error('[ruta-fria] error en /login:', err.message);
  }
  if (n === 0) return res.redirect('/setup');
  res.render('auth/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const usuario = await buscarPorUsername(String(username || '').trim());
    const ok = usuario && (await verificarPassword(usuario, password));
    if (!ok) {
      return res.render('auth/login', { error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.usuario = { id: usuario.id, username: usuario.username, nombre: usuario.nombre };
    res.redirect('/');
  } catch (err) {
    console.error('[ruta-fria] error en login:', err.message);
    res.render('auth/login', { error: 'Ocurrió un error. Probá de nuevo.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/setup', async (req, res) => {
  let n = 0;
  try {
    n = await contarUsuarios();
  } catch (err) {
    console.error('[ruta-fria] error en /setup:', err.message);
  }
  if (n > 0) return res.redirect('/login');
  res.render('auth/setup', { error: null });
});

router.post('/setup', async (req, res) => {
  try {
    const n = await contarUsuarios();
    if (n > 0) return res.redirect('/login');

    const { username, password, password2, nombre } = req.body;
    if (!username || !username.trim()) {
      return res.render('auth/setup', { error: 'Falta el nombre de usuario.' });
    }
    if (!password || password.length < 6) {
      return res.render('auth/setup', { error: 'La contraseña tiene que tener al menos 6 caracteres.' });
    }
    if (password !== password2) {
      return res.render('auth/setup', { error: 'Las contraseñas no coinciden.' });
    }

    const usuario = await crearUsuario({ username, password, nombre });
    req.session.usuario = { id: usuario.id, username: usuario.username, nombre: usuario.nombre };
    res.redirect('/');
  } catch (err) {
    console.error('[ruta-fria] error en setup:', err.message);
    const msg = /unique/i.test(err.message) ? 'Ese usuario ya existe.' : 'Ocurrió un error. Probá de nuevo.';
    res.render('auth/setup', { error: msg });
  }
});

module.exports = router;
