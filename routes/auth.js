const express = require('express');
const router = express.Router();
const { contarUsuarios, buscarPorUsername, crearUsuario, verificarPassword, datosSesion } = require('../lib/auth');
const { estaBloqueado, registrarFallo, registrarExito } = require('../lib/limiteIntentos');

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
  // Freno de fuerza bruta: por IP, independiente del de la app (ver
  // lib/limiteIntentos.js). Se chequea antes de tocar la base para no
  // gastar una consulta en un pedido que ya se sabe que va a fallar.
  const claveLimite = 'web:' + req.ip;
  const minutosBloqueada = estaBloqueado(claveLimite);
  if (minutosBloqueada) {
    return res.render('auth/login', {
      error: `Demasiados intentos fallidos. Probá de nuevo en ${minutosBloqueada} minuto${minutosBloqueada === 1 ? '' : 's'}.`,
    });
  }

  const { username, password } = req.body;
  try {
    const usuario = await buscarPorUsername(String(username || '').trim());
    const ok = usuario && (await verificarPassword(usuario, password));
    if (!ok) {
      registrarFallo(claveLimite);
      return res.render('auth/login', { error: 'Usuario o contraseña incorrectos.' });
    }
    registrarExito(claveLimite);
    req.session.usuario = datosSesion(usuario);
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

    // el primer usuario del sistema siempre nace administrador, con
    // acceso total — si no, nadie podría entrar nunca a Usuarios a
    // otorgarle permisos a sí mismo ni a nadie más
    const usuario = await crearUsuario({
      username,
      password,
      nombre,
      esAdmin: true,
      accesos: { clientes: true, articulos: true, compras: true, informes: true, ventas: true },
    });
    req.session.usuario = datosSesion(usuario);
    res.redirect('/');
  } catch (err) {
    console.error('[ruta-fria] error en setup:', err.message);
    const msg = /unique/i.test(err.message) ? 'Ese usuario ya existe.' : 'Ocurrió un error. Probá de nuevo.';
    res.render('auth/setup', { error: msg });
  }
});

module.exports = router;
