// Cuenta corriente de clientes: un libro de movimientos por cliente donde
// cada venta con forma_pago = 'cuenta_corriente' suma deuda (debe) sola,
// automáticamente (ver lib/cuentaCorriente.js, llamado desde
// routes/ventas.js — no hace falta cargar nada acá para eso) y cada
// recibo de pago que se carga a mano acá resta deuda (haber). También se
// puede cargar un ajuste manual — por ejemplo el saldo con el que arrancó
// un cliente que ya tenía cuenta corriente antes de este sistema, o una
// corrección — sin venta ni recibo asociado.
const express = require('express');
const pool = require('../db/pool');
const { fechaHoraInput, inputAFecha } = require('../lib/fechas');

const router = express.Router();

const MEDIOS_PAGO = ['efectivo', 'transferencia', 'cheque', 'otro'];
const ETIQUETAS_MEDIO_PAGO = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', otro: 'Otro' };

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

router.get('/', async (req, res, next) => {
  try {
    // Se lista todo cliente marcado como "cuenta corriente", más
    // cualquier otro que igual tenga un saldo distinto de 0 (por ejemplo
    // si cambió de condición de pago después de haber comprado a cuenta
    // corriente) — así no se pierde de vista una deuda pendiente.
    const { rows: clientes } = await pool.query(`
      select c.*, coalesce(m.saldo, 0) as saldo, coalesce(m.movimientos, 0)::int as movimientos
      from clientes c
      left join (
        select cliente_id, sum(debe) - sum(haber) as saldo, count(*) as movimientos
        from cuenta_corriente_movimientos
        group by cliente_id
      ) m on m.cliente_id = c.id
      where c.condicion_pago = 'cuenta_corriente' or coalesce(m.saldo, 0) <> 0
      order by saldo desc nulls last, c.razon_social
    `);
    const totalDeuda = redondear2(clientes.reduce((acc, c) => acc + Math.max(Number(c.saldo) || 0, 0), 0));
    res.render('cuenta-corriente/lista', { clientes, totalDeuda });
  } catch (err) { next(err); }
});

router.get('/:clienteId', async (req, res, next) => {
  try {
    const { rows: clienteRows } = await pool.query('select * from clientes where id = $1', [req.params.clienteId]);
    const cliente = clienteRows[0];
    if (!cliente) return res.redirect('/cuenta-corriente');

    const { rows: movs } = await pool.query(
      `select m.*, v.numero_remito, r.numero_recibo
       from cuenta_corriente_movimientos m
       left join ventas v on v.id = m.venta_id
       left join recibos r on r.id = m.recibo_id
       where m.cliente_id = $1
       order by m.fecha asc, m.id asc`,
      [cliente.id]
    );

    // Saldo corrido: se calcula acá (no se guarda en la base) para que
    // cada renglón muestre cómo iba quedando la cuenta en ese momento.
    let saldoAcumulado = 0;
    const movimientos = movs.map((m) => {
      saldoAcumulado = redondear2(saldoAcumulado + Number(m.debe) - Number(m.haber));
      return { ...m, saldoAcumulado };
    });

    res.render('cuenta-corriente/detalle', {
      cliente,
      movimientos,
      saldo: saldoAcumulado,
      mediosPago: MEDIOS_PAGO,
      etiquetasMedioPago: ETIQUETAS_MEDIO_PAGO,
      hoy: fechaHoraInput(),
      error: req.query.error || null,
    });
  } catch (err) { next(err); }
});

router.post('/:clienteId/recibos', async (req, res, next) => {
  const monto = redondear2(Number(req.body.monto) || 0);
  if (monto <= 0) {
    return res.redirect(`/cuenta-corriente/${req.params.clienteId}?error=` + encodeURIComponent('El monto del recibo tiene que ser mayor a 0.'));
  }

  const { fecha, notas } = req.body;
  const medio_pago = MEDIOS_PAGO.includes(req.body.medio_pago) ? req.body.medio_pago : 'efectivo';
  const fechaRecibo = inputAFecha(fecha) || new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into recibos (cliente_id, fecha, monto, medio_pago, notas)
       values ($1,$2,$3,$4,$5) returning id`,
      [req.params.clienteId, fechaRecibo, monto, medio_pago, notas || null]
    );
    await client.query(
      `insert into cuenta_corriente_movimientos (cliente_id, fecha, tipo, recibo_id, haber, notas)
       values ($1,$2,'recibo',$3,$4,$5)`,
      [req.params.clienteId, fechaRecibo, rows[0].id, monto, notas || null]
    );
    await client.query('COMMIT');
    res.redirect(`/cuenta-corriente/${req.params.clienteId}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/recibos/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from recibos where id = $1', [req.params.id]);
    const recibo = rows[0];
    if (!recibo) return res.redirect('/cuenta-corriente');
    res.render('cuenta-corriente/recibo-form', {
      recibo: { ...recibo, fecha: fechaHoraInput(recibo.fecha) },
      mediosPago: MEDIOS_PAGO,
      etiquetasMedioPago: ETIQUETAS_MEDIO_PAGO,
      error: null,
    });
  } catch (err) { next(err); }
});

router.post('/recibos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from recibos where id = $1', [req.params.id]);
    const recibo = rows[0];
    if (!recibo) return res.redirect('/cuenta-corriente');

    const { fecha, notas } = req.body;
    const monto = redondear2(Number(req.body.monto) || 0);
    const medio_pago = MEDIOS_PAGO.includes(req.body.medio_pago) ? req.body.medio_pago : 'efectivo';

    if (monto <= 0) {
      return res.render('cuenta-corriente/recibo-form', {
        recibo: { ...recibo, fecha, notas, medio_pago },
        mediosPago: MEDIOS_PAGO,
        etiquetasMedioPago: ETIQUETAS_MEDIO_PAGO,
        error: 'El monto del recibo tiene que ser mayor a 0.',
      });
    }

    const fechaRecibo = inputAFecha(fecha) || recibo.fecha;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'update recibos set fecha=$1, monto=$2, medio_pago=$3, notas=$4 where id=$5',
        [fechaRecibo, monto, medio_pago, notas || null, recibo.id]
      );
      // Se borra y se vuelve a crear el movimiento — mismo patrón que
      // sincronizarMovimientoVenta() para ventas.
      await client.query('delete from cuenta_corriente_movimientos where recibo_id = $1', [recibo.id]);
      await client.query(
        `insert into cuenta_corriente_movimientos (cliente_id, fecha, tipo, recibo_id, haber, notas)
         values ($1,$2,'recibo',$3,$4,$5)`,
        [recibo.cliente_id, fechaRecibo, recibo.id, monto, notas || null]
      );
      await client.query('COMMIT');
      res.redirect(`/cuenta-corriente/${recibo.cliente_id}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

router.post('/recibos/:id/eliminar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select cliente_id from recibos where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/cuenta-corriente');
    // cuenta_corriente_movimientos tiene "on delete cascade" sobre
    // recibo_id, así que el movimiento asociado se borra solo.
    await pool.query('delete from recibos where id = $1', [req.params.id]);
    res.redirect(`/cuenta-corriente/${rows[0].cliente_id}`);
  } catch (err) { next(err); }
});

router.post('/:clienteId/ajuste', async (req, res, next) => {
  try {
    const monto = redondear2(Number(req.body.monto) || 0);
    const tipoAjuste = req.body.ajuste_tipo === 'haber' ? 'haber' : 'debe';
    const notas = (req.body.notas || '').trim();
    const fecha = inputAFecha(req.body.fecha) || new Date();

    if (monto <= 0 || !notas) {
      const msg = monto <= 0 ? 'El monto del ajuste tiene que ser mayor a 0.' : 'Contá brevemente el motivo del ajuste.';
      return res.redirect(`/cuenta-corriente/${req.params.clienteId}?error=` + encodeURIComponent(msg));
    }

    await pool.query(
      `insert into cuenta_corriente_movimientos (cliente_id, fecha, tipo, debe, haber, notas)
       values ($1,$2,'ajuste',$3,$4,$5)`,
      [req.params.clienteId, fecha, tipoAjuste === 'debe' ? monto : 0, tipoAjuste === 'haber' ? monto : 0, notas]
    );
    res.redirect(`/cuenta-corriente/${req.params.clienteId}`);
  } catch (err) { next(err); }
});

module.exports = router;
