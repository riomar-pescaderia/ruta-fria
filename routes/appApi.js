// API para la app Android de los vendedores — pensada solo para
// localización a pedido, no para usar el resto de Ruta Fría desde el
// celular. No usa las cookies de sesión de la web (un celular no
// funciona bien con eso): cada dispositivo se loguea una vez y recibe un
// token propio, que manda en cada pedido siguiente con el encabezado
// "Authorization: Bearer <token>".
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { buscarPorUsername, verificarPassword } = require('../lib/auth');

const router = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// POST /api/app/login — usuario y contraseña son los mismos que ya usa
// esa persona para entrar a Ruta Fría desde la computadora; no hace
// falta crear un usuario aparte para la app.
router.post('/login', async (req, res) => {
  try {
    const { username, password, modelo } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Falta usuario o contraseña.' });
    }
    const usuario = await buscarPorUsername(username);
    if (!usuario || !(await verificarPassword(usuario, password))) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    const token = generarToken();
    const { rows } = await pool.query(
      'insert into app_dispositivos (usuario_id, token_sesion_hash, modelo) values ($1,$2,$3) returning id',
      [usuario.id, hashToken(token), modelo ? String(modelo).slice(0, 120) : null]
    );
    console.log(`[ruta-fria] login de app ok: usuario=${usuario.username} dispositivo_id=${rows[0].id} modelo=${modelo || '?'}`);
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre || usuario.username } });
  } catch (err) {
    console.error('[ruta-fria] error en login de app:', err.message);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// Protege el resto de los endpoints de este router: exige el token que
// devolvió /login. Un token es válido indefinidamente (no vence solo),
// hasta que un administrador desactive al usuario o se borre el
// dispositivo desde Ruta Fría — igual de largo que dura hoy la sesión
// web (30 días se renuevan solos, esto directamente no vence).
async function requireTokenApp(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Falta el token de autenticación.' });
    const { rows } = await pool.query(
      `select d.id as dispositivo_id, u.id as usuario_id, u.activo
       from app_dispositivos d
       join usuarios u on u.id = d.usuario_id
       where d.token_sesion_hash = $1`,
      [hashToken(token)]
    );
    if (!rows[0] || !rows[0].activo) {
      console.log(`[ruta-fria] token de app rechazado: encontrado=${!!rows[0]} activo=${rows[0] ? rows[0].activo : 'n/a'}`);
      return res.status(401).json({ error: 'Token inválido o usuario desactivado.' });
    }
    req.dispositivoId = rows[0].dispositivo_id;
    req.usuarioAppId = rows[0].usuario_id;
    pool.query('update app_dispositivos set ultimo_uso = now() where id = $1', [rows[0].dispositivo_id]).catch(() => {});
    next();
  } catch (err) {
    console.error('[ruta-fria] error validando token de app:', err.message);
    res.status(500).json({ error: 'Error del servidor.' });
  }
}

// POST /api/app/dispositivo/fcm — la app manda (o renueva) el token que
// le da Firebase Cloud Messaging a ESE celular — es lo que después
// permite mandarle la notificación de "mandá tu ubicación" a él en
// particular. Se llama después de loguearse y cada vez que Firebase le
// avisa a la app que el token cambió (pasa de vez en cuando).
router.post('/dispositivo/fcm', requireTokenApp, async (req, res) => {
  try {
    const { token_fcm } = req.body || {};
    if (!token_fcm) return res.status(400).json({ error: 'Falta token_fcm.' });
    await pool.query('update app_dispositivos set token_fcm = $1 where id = $2', [token_fcm, req.dispositivoId]);
    console.log(`[ruta-fria] token FCM guardado: dispositivo_id=${req.dispositivoId} token=${String(token_fcm).slice(0, 16)}...`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ruta-fria] error guardando token FCM:', err.message);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// POST /api/app/ubicacion — la app manda su posición actual. Pasa en dos
// casos: en respuesta a la notificación push de "solicitar_ubicacion", o
// sola cada cinco minutos mientras el vendedor está en horario laboral
// (ver TrackingService.kt en la app y GET /config acá abajo). En los dos
// casos queda: se pisa la "última posición conocida" (ubicaciones_usuarios,
// para el mapa en vivo) y además se agrega un renglón al historial de
// recorrido (ubicaciones_historial, para poder reconstruir la ruta del día).
router.post('/ubicacion', requireTokenApp, async (req, res) => {
  try {
    const { lat, lng, precision } = req.body || {};
    const latitud = Number(lat);
    const longitud = Number(lng);
    if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) {
      return res.status(400).json({ error: 'Faltan coordenadas válidas.' });
    }
    const precisionMetros = Number.isFinite(Number(precision)) ? Number(precision) : null;
    await pool.query(
      `insert into ubicaciones_usuarios (usuario_id, latitud, longitud, precision_metros, actualizado_en, solicitado_en)
       values ($1,$2,$3,$4, now(), null)
       on conflict (usuario_id) do update set
         latitud = excluded.latitud,
         longitud = excluded.longitud,
         precision_metros = excluded.precision_metros,
         actualizado_en = now(),
         solicitado_en = null`,
      [req.usuarioAppId, latitud, longitud, precisionMetros]
    );
    await pool.query(
      `insert into ubicaciones_historial (usuario_id, latitud, longitud, precision_metros)
       values ($1,$2,$3,$4)`,
      [req.usuarioAppId, latitud, longitud, precisionMetros]
    );
    console.log(`[ruta-fria] ubicación recibida del celular: usuario_id=${req.usuarioAppId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ruta-fria] error guardando ubicación:', err.message);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// GET /api/app/config — la app lo consulta al loguearse y cada vez que
// arranca el seguimiento del día, para saber entre qué horas tiene
// permitido mandar ubicación sola (lo configura un administrador desde
// /vendedores/ubicacion/horario). Son minutos desde la medianoche.
router.get('/config', requireTokenApp, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select clave, valor from config where clave in ('tracking_hora_inicio_min', 'tracking_hora_fin_min')`
    );
    const porClave = {};
    rows.forEach((r) => { porClave[r.clave] = Number(r.valor); });
    res.json({
      tracking_hora_inicio_min: porClave.tracking_hora_inicio_min ?? 480,
      tracking_hora_fin_min: porClave.tracking_hora_fin_min ?? 1140,
    });
  } catch (err) {
    console.error('[ruta-fria] error leyendo config de app:', err.message);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

module.exports = router;
