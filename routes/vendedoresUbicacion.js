// Ubicación de vendedores — solo para administradores. Dos mecanismos
// separados: "Localizar ahora" (lib/push.js) le pide al celular su
// posición en ese momento puntual, y aparte, mientras el vendedor está en
// horario laboral (configurable acá abajo en /horario), la app manda su
// posición sola cada cinco minutos — eso arma el historial de recorrido
// que se ve en /:usuarioId/historial. Los dos caminos escriben en las
// mismas tablas (ver routes/appApi.js): ubicaciones_usuarios queda con la
// última posición conocida (para el mapa en vivo de acá) y
// ubicaciones_historial acumula cada punto (para reconstruir la ruta).
const express = require('express');
const pool = require('../db/pool');
const { solicitarUbicacion, configurado } = require('../lib/push');
const { hoyAr } = require('../lib/fechas');

const router = express.Router();

// Distancia entre dos puntos (fórmula de Haversine), en kilómetros — se
// usa para sumar la distancia total de un recorrido a partir de sus
// puntos consecutivos. No pretende ser la distancia real manejada (no
// sigue calles), es la distancia en línea recta entre captura y captura;
// con un punto cada 5 minutos alcanza para una estimación razonable.
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
    console.log(`[ruta-fria] solicitando ubicación: usuario_id=${usuarioId} dispositivos_con_token=${tokens.length}`);
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
    console.log(`[ruta-fria] resultado del envío: enviados=${resultado.enviados} fallidos=${JSON.stringify(resultado.fallidos)}`);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[ruta-fria] error solicitando ubicación:', err.message);
    res.status(err.sinConfigurar ? 400 : 500).json({ error: err.message });
  }
});

// GET /vendedores/ubicacion/horario — pantalla para definir entre qué
// horas del día la app tiene permitido mandar ubicación sola. Fuera de
// ese rango la app no manda nada por su cuenta (sigue respondiendo a
// "Localizar ahora" a cualquier hora, eso es aparte).
router.get('/horario', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select clave, valor from config where clave in ('tracking_hora_inicio_min', 'tracking_hora_fin_min')`
    );
    const porClave = {};
    rows.forEach((r) => { porClave[r.clave] = Number(r.valor); });
    const minAHora = (min) => {
      const h = Math.floor(min / 60).toString().padStart(2, '0');
      const m = (min % 60).toString().padStart(2, '0');
      return `${h}:${m}`;
    };
    res.render('vendedores/horario', {
      horaInicio: minAHora(porClave.tracking_hora_inicio_min ?? 480),
      horaFin: minAHora(porClave.tracking_hora_fin_min ?? 1140),
      guardado: req.query.guardado === '1',
    });
  } catch (err) { next(err); }
});

router.post('/horario', async (req, res, next) => {
  try {
    const { hora_inicio, hora_fin } = req.body || {};
    const aMinutos = (valor) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor || ''));
      if (!m) return null;
      const horas = Number(m[1]);
      const minutos = Number(m[2]);
      if (horas < 0 || horas > 23 || minutos < 0 || minutos > 59) return null;
      return horas * 60 + minutos;
    };
    const inicioMin = aMinutos(hora_inicio);
    const finMin = aMinutos(hora_fin);
    if (inicioMin === null || finMin === null || inicioMin >= finMin) {
      return res.status(400).send('Horario inválido — la hora de inicio tiene que ser antes que la de fin.');
    }
    await pool.query(
      `insert into config (clave, valor) values ('tracking_hora_inicio_min', $1), ('tracking_hora_fin_min', $2)
       on conflict (clave) do update set valor = excluded.valor`,
      [inicioMin, finMin]
    );
    res.redirect('/vendedores/ubicacion/horario?guardado=1');
  } catch (err) { next(err); }
});

// GET /vendedores/ubicacion/:usuarioId/historial — ruta del día para un
// vendedor puntual: la pantalla carga el día de hoy de entrada, y desde
// ahí se puede cambiar de fecha sin recargar (ver /historial/datos).
router.get('/:usuarioId/historial', async (req, res, next) => {
  try {
    const usuarioId = req.params.usuarioId;
    const { rows } = await pool.query('select id, nombre, username from usuarios where id = $1', [usuarioId]);
    if (!rows[0]) return res.status(404).render('404');
    res.render('vendedores/historial', {
      vendedor: rows[0],
      fechaInicial: hoyAr(),
    });
  } catch (err) { next(err); }
});

// JSON con los puntos del día pedido (hora de Argentina) más la distancia
// total, para que el mapa de /historial se redibuje al cambiar de fecha
// sin recargar toda la pantalla.
router.get('/:usuarioId/historial/datos', async (req, res, next) => {
  try {
    const usuarioId = req.params.usuarioId;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : hoyAr();
    const { rows } = await pool.query(
      `select latitud, longitud, precision_metros, capturado_en
       from ubicaciones_historial
       where usuario_id = $1
         and (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date = $2::date
       order by capturado_en asc`,
      [usuarioId, fecha]
    );
    let km = 0;
    for (let i = 1; i < rows.length; i++) {
      km += distanciaKm(rows[i - 1].latitud, rows[i - 1].longitud, rows[i].latitud, rows[i].longitud);
    }
    res.json({
      fecha,
      puntos: rows.map((r) => ({
        lat: Number(r.latitud), lng: Number(r.longitud),
        precision: r.precision_metros !== null ? Number(r.precision_metros) : null,
        capturado_en: r.capturado_en,
      })),
      km: Math.round(km * 10) / 10,
    });
  } catch (err) { next(err); }
});

module.exports = router;
