// Stock — pantalla de control de cantidades por artículo. El saldo que se
// muestra (articulos.stock) y el historial de abajo los alimenta siempre
// lib/stock.js: cada venta resta, cada factura de mercadería confirmada
// suma, y acá un administrador puede además ajustar el stock a mano en
// cualquier momento (por ejemplo después de un recuento físico) — ese
// ajuste también genera su propio renglón en el historial, con el motivo
// que se haya escrito. El umbral de alerta ("stock mínimo") es opcional
// por artículo y también lo fija un administrador; por debajo de ese
// número (o en $0/negativo) el artículo se marca en el listado.
const express = require('express');
const pool = require('../db/pool');
const { registrarMovimiento } = require('../lib/stock');

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

router.get('/', async (req, res, next) => {
  try {
    const { rows: articulos } = await pool.query(`select * from articulos where activo = true order by
      case when codigo ~ '^[0-9]+$' then 0 else 1 end,
      case when codigo ~ '^[0-9]+$' then codigo::numeric end,
      codigo`);
    res.render('stock/lista', { articulos });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from articulos where id = $1', [req.params.id]);
    const articulo = rows[0];
    if (!articulo) return res.redirect('/stock');
    const movimientos = await historialDe(pool, articulo.id);
    res.render('stock/detalle', { articulo, movimientos, error: null });
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

    const texto = (req.body.nueva_cantidad || '').trim();
    const nuevaCantidad = texto === '' ? NaN : redondear2(Number(texto));
    if (texto === '' || Number.isNaN(nuevaCantidad)) {
      const movimientos = await historialDe(client, articulo.id);
      return res.render('stock/detalle', {
        articulo,
        movimientos,
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
