// Localización de vendedores a pedido — solo para administradores. No
// hay rastreo continuo ni automático: cada vez que se pide la ubicación
// de alguien, se le manda una notificación push a su celular (ver
// lib/push.js) y la app responde con su posición en ese momento; solo se
// guarda la última, no un recorrido.
const express = require('express');
const pool = require('../db/pool');
const { solicitarUbicacion, configurado } = require('../lib/push');

const router = express.Router();

const CONSULTA_VENDEDORES = `
  select u.id, u.nombre, u.username,
    exists(select 1 from app_dispositivos d where d.usuario_id = u.id) as tiene_app,
    ub.latitud, ub.longitud, ub.precision_metros, ub.actualizado_en, ub.solicitado_en
  from usuarios u
  left join ubicaciones_usuarios ub on ub.usuario_id = u.id
  where u.activo = true
  order by u.nombre nulls last, u.username
`;

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(CONSULTA_VENDEDORES);
    res.render('vendedores/ubicacion', { vendedores: rows, firebaseConfigurado: configurado() });
  } catch (err) { next(err); }
});

// JSON que usa la pantalla para refrescarse sola cada tanto, sin recargar
// toda la página — así se ve cuando llega la respuesta a un pedido de
// ubicación, sin que el administrador tenga que tocar nada.
router.get('/estado', async (req, res, next) => {
  try {
    const { rows } = await pool.query(CONSULTA_VENDEDORES);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:usuarioId/solicitar', async (req, res) => {
  try {
    const usuarioId = req.params.usuarioId;
    const { rows } = await pool.query(
      'select token_fcm from app_dispositivos where usuario_id = $1 and token_fcm is not null',
      [usuarioId]
    );
    const tokens = rows.map((r) => r.token_fcm);
    if (tokens.length === 0) {
      return res.status(400).json({
        error: 'Este usuario todavía no instaló la app (o no terminó de configurarla), así que no le puedo pedir la ubicación todavía.',
      });
    }
    await pool.query(
      `insert into ubicaciones_usuarios (usuario_id, solicitado_en) values ($1, now())
       on conflict (usuario_id) do update set solicitado_en = now()`,
      [usuarioId]
    );
    const resultado = await solicitarUbicacion(tokens);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[ruta-fria] error solicitando ubicación:', err.message);
    res.status(err.sinConfigurar ? 400 : 500).json({ error: err.message });
  }
});

module.exports = router;
