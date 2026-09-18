// Stock — pantalla de control de cantidades por artículo. Hay dos modos
// posibles (stock_config.modo, ver db/schema.sql):
//   - "automatico": el saldo lo mueven solas cada venta y cada factura de
//     mercadería confirmada (ver routes/ventas.js y routes/compras.js), y
//     un administrador puede además ajustarlo a mano en cualquier
//     momento — pensado para cuando el depósito propio esté operativo.
//   - "planilla": modo puente para mientras tanto — el stock de todos
//     los artículos sale únicamente de una hoja de cálculo externa (ver
//     lib/stockPlanilla.js), que se vuelve a leer cada vez que se abre
//     esta pantalla (o con el botón "Sincronizar ahora"); en este modo
//     ventas y compras no tocan articulos.stock.
// En los dos modos, cada movimiento (venta, compra, ajuste a mano o
// sincronización con la planilla) pasa por registrarMovimiento y queda
// en el historial de stock_movimientos.
const express = require('express');
const pool = require('../db/pool');
const { registrarMovimiento, obtenerConfigStock } = require('../lib/stock');
const { sincronizarStockDesdePlanilla } = require('../lib/stockPlanilla');

const router = express.Router();

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

function esAdmin(req) {
  return !!(req.session.usuario && req.session.usuario.esAdmin);
}

async function historialDe(client, articuloId) {
  const { rows } = await client.query(
    `select m.*, u.nombre as usuario_nombre, u.username as usuario_username
     from stock_movimientos m left join usuarios u on u.id = m.usuario_id
     where m.articulo_id = $1
     order by m.fecha desc, m.id desc
     limit 200`,
    [articuloId]
  );
  return rows;
}

// Si el modo vigente es "planilla", vuelve a leerla y aplica los cambios
// — nunca tira si falla (una hoja caída o sin conexión no puede romper
// la pantalla de Stock): guarda el error en stock_config para mostrarlo,
// y de paso muestra los últimos valores conocidos.
async function sincronizarSiCorresponde(cfg, req) {
  if (cfg.modo !== 'planilla') return null;
  if (!cfg.planilla_url) return { error: 'Todavía no se configuró el link de la planilla.' };
  try {
    const resumen = await sincronizarStockDesdePlanilla({
      sheetUrl: cfg.planilla_url,
      nombrePlanilla: cfg.planilla_nombre,
      usuarioId: req.session.usuario.id,
    });
    return resumen;
  } catch (err) {
    await pool.query('update stock_config set ultimo_error = $1 where id = 1', [err.message]);
    return { error: err.message };
  }
}

router.get('/', async (req, res, next) => {
  try {
    const cfg = await obtenerConfigStock();
    const sync = await sincronizarSiCorresponde(cfg, req);
    const cfgFinal = await obtenerConfigStock();
    const { rows: articulos } = await pool.query(`select * from articulos where activo = true order by
      case when codigo ~ '^[0-9]+$' then 0 else 1 end,
      case when codigo ~ '^[0-9]+$' then codigo::numeric end,
      codigo`);
    res.render('stock/lista', { articulos, config: cfgFinal, sync });
  } catch (err) { next(err); }
});

router.post('/configuracion', async (req, res, next) => {
  if (!esAdmin(req)) {
    return res.status(403).render('403', { motivo: 'Configurar el origen del stock es solo para administradores.' });
  }
  try {
    const modo = req.body.modo === 'planilla' ? 'planilla' : 'automatico';
    const planillaUrl = (req.body.planilla_url || '').trim() || null;
    const planillaNombre = (req.body.planilla_nombre || '').trim() || null;
    await pool.query(
      'update stock_config set modo=$1, planilla_url=$2, planilla_nombre=$3, ultimo_error=null where id=1',
      [modo, planillaUrl, planillaNombre]
    );
    res.redirect('/stock');
  } catch (err) { next(err); }
});

router.post('/sincronizar', async (req, res, next) => {
  try {
    const cfg = await obtenerConfigStock();
    await sincronizarSiCorresponde(cfg, req);
    const volver = req.body.volver;
    res.redirect(volver ? `/stock/${volver}` : '/stock');
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from articulos where id = $1', [req.params.id]);
    const articulo = rows[0];
    if (!articulo) return res.redirect('/stock');
    const cfg = await obtenerConfigStock();
    const movimientos = await historialDe(pool, articulo.id);
    res.render('stock/detalle', { articulo, movimientos, config: cfg, error: null });
  } catch (err) { next(err); }
});

router.post('/:id/ajustar', async (req, res, next) => {
  if (!esAdmin(req)) {
    return res.status(403).render('403', { motivo: 'Ajustar el stock a mano es solo para administradores.' });
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select * from articulos where id = $1', [req.params.id]);
    const articulo = rows[0];
    if (!articulo) return res.redirect('/stock');
    const cfg = await obtenerConfigStock(client);

    const texto = (req.body.nueva_cantidad || '').trim();
    const nuevaCantidad = texto === '' ? NaN : redondear2(Number(texto));
    if (texto === '' || Number.isNaN(nuevaCantidad)) {
      const movimientos = await historialDe(client, articulo.id);
      return res.render('stock/detalle', {
        articulo,
        movimientos,
        config: cfg,
        error: 'Ingresá la nueva cantidad de stock.',
      });
    }

    const stockActual = Number(articulo.stock) || 0;
    const delta = redondear2(nuevaCantidad - stockActual);
    const motivo = (req.body.motivo || '').trim() || null;

    await client.query('BEGIN');
    if (delta !== 0) {
      await registrarMovimiento(client, {
        articuloId: articulo.id,
        tipo: 'ajuste',
        cantidad: delta,
        motivo,
        usuarioId: req.session.usuario.id,
      });
    }
    await client.query('COMMIT');
    res.redirect(`/stock/${articulo.id}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/umbral', async (req, res, next) => {
  if (!esAdmin(req)) {
    return res.status(403).render('403', { motivo: 'Fijar el umbral de alerta es solo para administradores.' });
  }
  try {
    const texto = (req.body.stock_minimo || '').trim();
    const stockMinimo = texto === '' ? null : redondear2(Number(texto));
    await pool.query('update articulos set stock_minimo = $1 where id = $2', [stockMinimo, req.params.id]);
    res.redirect(`/stock/${req.params.id}`);
  } catch (err) { next(err); }
});

module.exports = router;
