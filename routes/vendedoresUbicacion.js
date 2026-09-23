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

// Helpers de fecha para los rangos rápidos del histórico de recorrido —
// mismo criterio que ya usa el Panel de Informes (routes/informes.js):
// se arman a partir de "hoy" en hora de Argentina, con new Date() en
// horario de pared (sin componente de hora) para no depender de en qué
// huso horario esté corriendo el server.
function aFechaISO(d) {
  return d.toLocaleDateString('en-CA');
}
function primerDiaMes(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  return aFechaISO(new Date(d.getFullYear(), d.getMonth(), 1));
}
function primerDiaMesAnterior(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  return aFechaISO(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}
function ultimoDiaMesAnterior(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  return aFechaISO(new Date(d.getFullYear(), d.getMonth(), 0)); // día "0" de este mes = último día del anterior
}
// "2000-01-01" como piso fijo para "Todo el período" — más simple que
// consultar la fecha real del primer punto guardado, y da lo mismo (no
// hay datos de antes de que existiera el seguimiento).
const DESDE_TODO_EL_PERIODO = '2000-01-01';

function armarRangosRapidosHistorico(hoy) {
  return [
    { etiqueta: 'Mes actual', desde: primerDiaMes(hoy), hasta: hoy },
    { etiqueta: 'Mes anterior', desde: primerDiaMesAnterior(hoy), hasta: ultimoDiaMesAnterior(hoy) },
    { etiqueta: 'Este año', desde: hoy.slice(0, 4) + '-01-01', hasta: hoy },
    { etiqueta: 'Todo el período', desde: DESDE_TODO_EL_PERIODO, hasta: hoy },
  ];
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

// Días de la semana en el orden en que se muestran en la pantalla
// (semana laboral primero) — dia_semana adentro de cada uno es el mismo
// número que usa la tabla tracking_horarios (0=domingo … 6=sábado, igual
// que extract(dow from ...) de Postgres).
const DIAS_SEMANA = [
  { diaSemana: 1, etiqueta: 'Lunes' },
  { diaSemana: 2, etiqueta: 'Martes' },
  { diaSemana: 3, etiqueta: 'Miércoles' },
  { diaSemana: 4, etiqueta: 'Jueves' },
  { diaSemana: 5, etiqueta: 'Viernes' },
  { diaSemana: 6, etiqueta: 'Sábado' },
  { diaSemana: 0, etiqueta: 'Domingo' },
];

function minAHora(min) {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

// Convierte "HH:MM" a minutos desde la medianoche, o null si no es una
// hora válida — mismo criterio que ya usaba el horario único viejo.
function aMinutos(valor) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor || ''));
  if (!m) return null;
  const horas = Number(m[1]);
  const minutos = Number(m[2]);
  if (horas < 0 || horas > 23 || minutos < 0 || minutos > 59) return null;
  return horas * 60 + minutos;
}

// GET /vendedores/ubicacion/horario — pantalla para definir, día por día
// de la semana, entre qué horas la app tiene permitido mandar ubicación
// sola. Cada día puede tener varias franjas (por ejemplo 9 a 13 y 17 a
// 22) o ninguna (seguimiento apagado ese día). Fuera de las franjas
// cargadas la app no manda nada por su cuenta (sigue respondiendo a
// "Localizar ahora" a cualquier hora, eso es aparte).
router.get('/horario', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select dia_semana, hora_inicio_min, hora_fin_min from tracking_horarios order by dia_semana, hora_inicio_min'
    );
    const franjasPorDia = {};
    rows.forEach((r) => {
      if (!franjasPorDia[r.dia_semana]) franjasPorDia[r.dia_semana] = [];
      franjasPorDia[r.dia_semana].push({ inicio: minAHora(r.hora_inicio_min), fin: minAHora(r.hora_fin_min) });
    });
    const dias = DIAS_SEMANA.map((d) => ({
      ...d,
      activo: !!franjasPorDia[d.diaSemana],
      // Un día activo sin franjas no debería pasar nunca (se guarda como
      // inactivo), pero por las dudas se arranca con una franja en blanco
      // para que el formulario tenga algo para mostrar.
      franjas: franjasPorDia[d.diaSemana] || [{ inicio: '', fin: '' }],
    }));
    res.render('vendedores/horario', {
      dias,
      guardado: req.query.guardado === '1',
      error: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/horario', async (req, res, next) => {
  try {
    const diasBody = (req.body && req.body.dias) || {};
    // Filas a insertar, ya validadas — y en paralelo, un texto de error
    // legible si algo no cierra, para poder avisar en qué día está el
    // problema en vez de un genérico "horario inválido".
    const filas = [];
    for (const { diaSemana, etiqueta } of DIAS_SEMANA) {
      const diaBody = diasBody[String(diaSemana)];
      if (!diaBody || diaBody.activo !== 'on') continue; // día apagado: no se guarda ninguna franja

      const franjasBody = Array.isArray(diaBody.franjas)
        ? diaBody.franjas
        : Object.values(diaBody.franjas || {});
      const franjasDia = [];
      for (const f of franjasBody) {
        const inicioTexto = f && f.inicio;
        const finTexto = f && f.fin;
        if (!inicioTexto && !finTexto) continue; // fila en blanco (se agregó y no se completó) — se ignora sola
        const inicioMin = aMinutos(inicioTexto);
        const finMin = aMinutos(finTexto);
        if (inicioMin === null || finMin === null || inicioMin >= finMin) {
          return res.redirect(
            '/vendedores/ubicacion/horario?error=' +
            encodeURIComponent(`${etiqueta}: cada franja necesita una hora de inicio anterior a la de fin.`)
          );
        }
        franjasDia.push({ inicioMin, finMin });
      }
      if (franjasDia.length === 0) continue; // día tildado como activo pero sin ninguna franja cargada: queda apagado igual

      // Dos franjas del mismo día no pueden superponerse (por ejemplo 9 a
      // 14 y 13 a 18) — se ordenan por inicio y se compara cada una con
      // la siguiente.
      franjasDia.sort((a, b) => a.inicioMin - b.inicioMin);
      for (let i = 1; i < franjasDia.length; i++) {
        if (franjasDia[i].inicioMin < franjasDia[i - 1].finMin) {
          return res.redirect(
            '/vendedores/ubicacion/horario?error=' +
            encodeURIComponent(`${etiqueta}: hay dos franjas que se superponen.`)
          );
        }
      }
      franjasDia.forEach((f) => filas.push({ diaSemana, ...f }));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('delete from tracking_horarios');
      for (const f of filas) {
        await client.query(
          'insert into tracking_horarios (dia_semana, hora_inicio_min, hora_fin_min) values ($1,$2,$3)',
          [f.diaSemana, f.inicioMin, f.finMin]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
    const hoy = hoyAr();
    res.render('vendedores/historial', {
      vendedor: rows[0],
      fechaInicial: hoy,
      rangosRapidosHistorico: armarRangosRapidosHistorico(hoy),
      // El histórico de abajo arranca mostrando el mes actual — el mapa
      // de arriba sigue arrancando en el día de hoy (fechaInicial), son
      // dos cosas independientes.
      filtroHistoricoInicial: { desde: primerDiaMes(hoy), hasta: hoy },
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

// JSON con el histórico día por día (fecha, hora de inicio y fin, y km
// recorridos) para un vendedor en un rango de fechas — lo que llena la
// tabla debajo del mapa en /historial. Trabaja agrupado por día
// directamente en SQL (en vez de traer cada punto y sumar en JS, como
// hace /historial/datos para un solo día) para que "Todo el período"
// ande liviano aunque haya meses de puntos acumulados.
router.get('/:usuarioId/historial/resumen', async (req, res, next) => {
  try {
    const usuarioId = req.params.usuarioId;
    const hoy = hoyAr();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : primerDiaMes(hoy);
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : hoy;
    const { rows } = await pool.query(
      `with puntos as (
         select
           (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date as fecha,
           capturado_en, latitud, longitud,
           lag(latitud) over (partition by (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date order by capturado_en) as lat_prev,
           lag(longitud) over (partition by (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date order by capturado_en) as lng_prev
         from ubicaciones_historial
         where usuario_id = $1
           and (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date >= $2::date
           and (capturado_en at time zone 'America/Argentina/Buenos_Aires')::date <= $3::date
       )
       select
         to_char(fecha, 'YYYY-MM-DD') as fecha,
         to_char(min(capturado_en) at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') as hora_inicio,
         to_char(max(capturado_en) at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') as hora_fin,
         count(*)::int as cantidad,
         -- Misma fórmula de Haversine que distanciaKm() de acá arriba,
         -- pero calculada en SQL (con lag()) para no traer cada punto —
         -- el "least(1, ...)" es solo para cubrirse de un redondeo de
         -- punto flotante que deje el argumento de asin() en 1.0000001,
         -- lo que rompería la cuenta con un NaN.
         coalesce(sum(
           case when lat_prev is null then 0 else
             6371 * 2 * asin(least(1, sqrt(
               sin(radians(latitud - lat_prev)/2)^2 +
               cos(radians(lat_prev)) * cos(radians(latitud)) * sin(radians(longitud - lng_prev)/2)^2
             )))
           end
         ), 0)::numeric as km
       from puntos
       group by fecha
       order by fecha desc`,
      [usuarioId, desde, hasta]
    );
    const dias = rows.map((r) => ({
      fecha: r.fecha,
      horaInicio: r.hora_inicio,
      horaFin: r.hora_fin,
      cantidad: r.cantidad,
      km: Math.round(Number(r.km) * 10) / 10,
    }));
    res.json({
      desde,
      hasta,
      dias,
      totalKm: Math.round(dias.reduce((acc, d) => acc + d.km, 0) * 10) / 10,
      totalDias: dias.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
