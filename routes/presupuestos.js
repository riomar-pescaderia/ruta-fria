// Presupuestos — la misma idea que una venta (cliente + renglones de
// artículos + forma de pago) pero pensada para cotizarle un precio al
// cliente antes de que haya una venta real: tiene su propia numeración
// (separada de la de ventas/remitos) y no toca stock ni cuenta
// corriente en ningún momento, ni al crearlo ni al editarlo ni al
// borrarlo. Al guardarlo (crear o editar) se ofrece generar el PDF ahí
// mismo, para imprimir o guardarlo en el momento — ver el query param
// "guardado" y el script de views/presupuestos/detalle.ejs.
const express = require('express');
const pool = require('../db/pool');
const { getConfig } = require('../lib/config');
const { calcularPrecios } = require('../lib/precios');
const { fechaHoraInput, inputAFecha } = require('../lib/fechas');

const router = express.Router();

const FORMAS_PAGO = ['efectivo', 'transferencia', 'cuenta_corriente'];

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

async function datosFormulario() {
  const [{ rows: clientes }, { rows: articulosRaw }, config] = await Promise.all([
    pool.query('select * from clientes order by razon_social'),
    pool.query(`select * from articulos where activo = true order by
      case when codigo ~ '^[0-9]+$' then 0 else 1 end,
      case when codigo ~ '^[0-9]+$' then codigo::numeric end,
      codigo`),
    getConfig(),
  ]);
  const articulos = articulosRaw.map((a) => ({ ...a, ...calcularPrecios(a, config) }));
  return { clientes, articulos };
}

function leerItems(body) {
  const raw = body.items;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr
    .filter((it) => it && it.articulo_id)
    .map((it) => {
      const cantidad = redondear2(Number(it.cantidad) || 0);
      const precio_unitario = redondear2(Number(it.precio_unitario) || 0);
      return {
        articulo_id: it.articulo_id,
        cantidad,
        precio_unitario,
        subtotal: redondear2(cantidad * precio_unitario),
      };
    })
    .filter((it) => it.cantidad > 0 && it.precio_unitario > 0);
}

// Mismo criterio que en Ventas: si no se elige un cliente ya agendado
// pero se tipeó un nombre a mano, se reutiliza uno existente con ese
// nombre o se crea uno nuevo con nada más que el nombre.
async function resolverClienteId(cliente_id, clienteTexto) {
  if (cliente_id) return cliente_id;
  const nombre = (clienteTexto || '').trim();
  if (!nombre) return null;
  const { rows: existentes } = await pool.query(
    'select id from clientes where lower(razon_social) = lower($1) limit 1',
    [nombre]
  );
  if (existentes[0]) return existentes[0].id;
  const { rows } = await pool.query(
    'insert into clientes (razon_social) values ($1) returning id',
    [nombre]
  );
  return rows[0].id;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows: presupuestos } = await pool.query(
      `select p.*, c.razon_social as cliente_nombre
       from presupuestos p join clientes c on c.id = p.cliente_id
       order by p.fecha desc, p.id desc`
    );
    res.render('presupuestos/lista', { presupuestos });
  } catch (err) { next(err); }
});

router.get('/nuevo', async (req, res, next) => {
  try {
    const { clientes, articulos } = await datosFormulario();
    res.render('presupuestos/form', {
      presupuesto: { fecha: fechaHoraInput(), forma_pago: 'efectivo' },
      items: [{}],
      clientes,
      articulos,
      error: null,
      accion: '/ventas/presupuestos',
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { fecha, notas } = req.body;
  const clienteTexto = (req.body.cliente_texto || '').trim();
  let cliente_id = req.body.cliente_id || null;
  const forma_pago = FORMAS_PAGO.includes(req.body.forma_pago) ? req.body.forma_pago : null;
  const items = leerItems(req.body);

  if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
    try {
      const { clientes, articulos } = await datosFormulario();
      return res.render('presupuestos/form', {
        presupuesto: { cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, notas },
        items: items.length ? items : [{}],
        clientes,
        articulos,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: '/ventas/presupuestos',
      });
    } catch (err) { return next(err); }
  }

  try {
    cliente_id = await resolverClienteId(cliente_id, clienteTexto);
  } catch (err) { return next(err); }

  const total = redondear2(items.reduce((acc, it) => acc + it.subtotal, 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fechaPresupuesto = inputAFecha(fecha) || new Date();
    const { rows } = await client.query(
      `insert into presupuestos (cliente_id, fecha, forma_pago, notas, total)
       values ($1,$2,$3,$4,$5) returning id`,
      [cliente_id, fechaPresupuesto, forma_pago, notas || null, total]
    );
    const presupuestoId = rows[0].id;
    for (const it of items) {
      await client.query(
        `insert into presupuestos_items (presupuesto_id, articulo_id, cantidad, precio_unitario, subtotal)
         values ($1,$2,$3,$4,$5)`,
        [presupuestoId, it.articulo_id, it.cantidad, it.precio_unitario, it.subtotal]
      );
    }
    await client.query('COMMIT');
    res.redirect(`/ventas/presupuestos/${presupuestoId}?guardado=1`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from presupuestos where id = $1', [req.params.id]);
    const presupuesto = rows[0];
    if (!presupuesto) return res.redirect('/ventas/presupuestos');
    const { rows: items } = await pool.query('select * from presupuestos_items where presupuesto_id = $1 order by id', [presupuesto.id]);
    const { clientes, articulos } = await datosFormulario();
    res.render('presupuestos/form', {
      presupuesto: { ...presupuesto, fecha: fechaHoraInput(presupuesto.fecha) },
      items,
      clientes,
      articulos,
      error: null,
      accion: `/ventas/presupuestos/${presupuesto.id}`,
    });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  const { fecha, notas } = req.body;
  const clienteTexto = (req.body.cliente_texto || '').trim();
  let cliente_id = req.body.cliente_id || null;
  const forma_pago = FORMAS_PAGO.includes(req.body.forma_pago) ? req.body.forma_pago : null;
  const items = leerItems(req.body);

  try {
    const { rows } = await pool.query('select * from presupuestos where id = $1', [req.params.id]);
    const presupuesto = rows[0];
    if (!presupuesto) return res.redirect('/ventas/presupuestos');

    if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
      const { clientes, articulos } = await datosFormulario();
      return res.render('presupuestos/form', {
        presupuesto: { id: presupuesto.id, cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, notas },
        items: items.length ? items : [{}],
        clientes,
        articulos,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: `/ventas/presupuestos/${presupuesto.id}`,
      });
    }

    cliente_id = await resolverClienteId(cliente_id, clienteTexto);
    const total = redondear2(items.reduce((acc, it) => acc + it.subtotal, 0));
    const fechaPresupuesto = inputAFecha(fecha) || presupuesto.fecha;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'update presupuestos set cliente_id=$1, fecha=$2, forma_pago=$3, notas=$4, total=$5 where id=$6',
        [cliente_id, fechaPresupuesto, forma_pago, notas || null, total, presupuesto.id]
      );
      await client.query('delete from presupuestos_items where presupuesto_id = $1', [presupuesto.id]);
      for (const it of items) {
        await client.query(
          `insert into presupuestos_items (presupuesto_id, articulo_id, cantidad, precio_unitario, subtotal)
           values ($1,$2,$3,$4,$5)`,
          [presupuesto.id, it.articulo_id, it.cantidad, it.precio_unitario, it.subtotal]
        );
      }
      await client.query('COMMIT');
      res.redirect(`/ventas/presupuestos/${presupuesto.id}?guardado=1`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select p.*, c.razon_social as cliente_nombre, c.direccion as cliente_direccion,
              c.telefono as cliente_telefono, c.cuit_dni as cliente_cuit_dni,
              c.condicion_iva as cliente_condicion_iva
       from presupuestos p join clientes c on c.id = p.cliente_id
       where p.id = $1`,
      [req.params.id]
    );
    const presupuesto = rows[0];
    if (!presupuesto) return res.redirect('/ventas/presupuestos');
    const { rows: items } = await pool.query(
      `select i.*, a.codigo, a.nombre
       from presupuestos_items i join articulos a on a.id = i.articulo_id
       where i.presupuesto_id = $1
       order by i.id`,
      [presupuesto.id]
    );
    res.render('presupuestos/detalle', { presupuesto, items, guardado: req.query.guardado === '1' });
  } catch (err) { next(err); }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    // presupuestos_items tiene "on delete cascade" sobre presupuesto_id,
    // así que se borran solos los renglones de este presupuesto.
    await pool.query('delete from presupuestos where id = $1', [req.params.id]);
    res.redirect('/ventas/presupuestos');
  } catch (err) { next(err); }
});

module.exports = router;
