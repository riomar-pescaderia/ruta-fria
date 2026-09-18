// Ventas / remitos. Cada venta es un cliente + una lista de artículos con
// cantidad y precio, con una forma de pago que define qué precio
// corresponde: efectivo va al precio en efectivo (mayorista), transferencia
// y cuenta corriente van al precio de lista (que ya incluye el recargo por
// medio de pago). Cada renglón descuenta stock del artículo vendido (ver
// lib/stock.js) — y no tiene un paso de confirmación como Compras: una
// venta queda siempre editable y se puede borrar en cualquier momento, así
// que al editarla se devuelve el stock de los renglones viejos antes de
// descontar el de los nuevos, y al borrarla se devuelve el de todos sus
// renglones. El estado (emitido / entregado / cobrado) se cambia a mano
// desde el detalle, para hacer seguimiento del reparto y del cobro.
const express = require('express');
const pool = require('../db/pool');
const { getConfig } = require('../lib/config');
const { calcularPrecios } = require('../lib/precios');
const { sincronizarMovimientoVenta } = require('../lib/cuentaCorriente');
const { registrarMovimiento, obtenerConfigStock } = require('../lib/stock');
const presupuestosRouter = require('./presupuestos');

const router = express.Router();

// Va antes que cualquier ruta "/:id" de acá abajo — si no, Express
// interpretaría "/presupuestos" como un intento de abrir la venta con
// id "presupuestos" en vez de entrar al router de presupuestos.
router.use('/presupuestos', presupuestosRouter);

const FORMAS_PAGO = ['efectivo', 'transferencia', 'cuenta_corriente'];
const ESTADOS = ['emitido', 'entregado', 'cobrado'];
const ORIGENES = ['deposito', 'calle'];

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

// Hoy, en la zona horaria del negocio — para no depender de en qué huso
// horario esté corriendo el servidor (Render corre en UTC).
function hoyAr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Una columna "date"/"timestamptz" de Postgres vuelve como Date de JS —
// esto la deja en el formato que espera un <input type="date">.
function fechaInput(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
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

// Lee los renglones que vienen del formulario (items[0][...], items[1][...]),
// descarta los incompletos (fila vacía que quedó de sobra, o sin artículo
// elegido) y calcula el subtotal de cada uno.
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

// Si vino un cliente_id (elegido del buscador) se usa tal cual. Si no,
// pero se tipeó un nombre a mano — pensado para cargar la venta ya mismo
// en la calle sin tener que agendar antes al cliente — se reutiliza un
// cliente existente con ese mismo nombre si lo hay (para no duplicar si
// en realidad ya estaba cargado y no se eligió de la lista) o se crea uno
// nuevo con ese nombre y nada más: el resto de sus datos se completa
// después, desde el link "Completar datos del cliente" que queda en el
// detalle de la venta.
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
    const { rows: ventas } = await pool.query(
      `select v.*, c.razon_social as cliente_nombre
       from ventas v join clientes c on c.id = v.cliente_id
       order by v.fecha desc, v.id desc`
    );
    res.render('ventas/lista', { ventas });
  } catch (err) { next(err); }
});

router.get('/nueva', async (req, res, next) => {
  try {
    const { clientes, articulos } = await datosFormulario();
    res.render('ventas/form', {
      venta: { fecha: hoyAr(), forma_pago: 'efectivo', origen: 'deposito' },
      items: [{}],
      clientes,
      articulos,
      error: null,
      accion: '/ventas',
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { fecha, notas } = req.body;
  const clienteTexto = (req.body.cliente_texto || '').trim();
  let cliente_id = req.body.cliente_id || null;
  const forma_pago = FORMAS_PAGO.includes(req.body.forma_pago) ? req.body.forma_pago : null;
  const origen = ORIGENES.includes(req.body.origen) ? req.body.origen : 'deposito';
  const items = leerItems(req.body);

  if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
    try {
      const { clientes, articulos } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, origen, notas },
        items: items.length ? items : [{}],
        clientes,
        articulos,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: '/ventas',
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
    const cfgStock = await obtenerConfigStock(client);
    const fechaVenta = fecha || hoyAr();
    const { rows } = await client.query(
      `insert into ventas (cliente_id, fecha, forma_pago, origen, notas, total)
       values ($1,$2,$3,$4,$5,$6) returning id, numero_remito`,
      [cliente_id, fechaVenta, forma_pago, origen, notas || null, total]
    );
    const ventaId = rows[0].id;
    for (const it of items) {
      await client.query(
        `insert into ventas_items (venta_id, articulo_id, cantidad, precio_unitario, subtotal)
         values ($1,$2,$3,$4,$5)`,
        [ventaId, it.articulo_id, it.cantidad, it.precio_unitario, it.subtotal]
      );
      // En modo "planilla" el stock lo maneja únicamente la hoja externa
      // (ver lib/stockPlanilla.js) — la venta no lo toca hasta que se
      // vuelva al modo automático.
      if (cfgStock.modo === 'automatico') {
        await registrarMovimiento(client, {
          articuloId: it.articulo_id,
          tipo: 'venta',
          cantidad: -it.cantidad,
          usuarioId: req.session.usuario.id,
          ventaId,
        });
      }
    }
    await sincronizarMovimientoVenta(client, {
      id: ventaId,
      cliente_id,
      fecha: fechaVenta,
      forma_pago,
      total,
      numero_remito: rows[0].numero_remito,
    });
    await client.query('COMMIT');
    res.redirect(`/ventas/${ventaId}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from ventas where id = $1', [req.params.id]);
    const venta = rows[0];
    if (!venta) return res.redirect('/ventas');
    const { rows: items } = await pool.query('select * from ventas_items where venta_id = $1 order by id', [venta.id]);
    const { clientes, articulos } = await datosFormulario();
    res.render('ventas/form', {
      venta: { ...venta, fecha: fechaInput(venta.fecha) },
      items,
      clientes,
      articulos,
      error: null,
      accion: `/ventas/${venta.id}`,
    });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  const { fecha, notas } = req.body;
  const clienteTexto = (req.body.cliente_texto || '').trim();
  let cliente_id = req.body.cliente_id || null;
  const forma_pago = FORMAS_PAGO.includes(req.body.forma_pago) ? req.body.forma_pago : null;
  const origen = ORIGENES.includes(req.body.origen) ? req.body.origen : 'deposito';
  const items = leerItems(req.body);

  try {
    const { rows } = await pool.query('select * from ventas where id = $1', [req.params.id]);
    const venta = rows[0];
    if (!venta) return res.redirect('/ventas');

    if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
      const { clientes, articulos } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { id: venta.id, cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, origen, notas },
        items: items.length ? items : [{}],
        clientes,
        articulos,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: `/ventas/${venta.id}`,
      });
    }

    cliente_id = await resolverClienteId(cliente_id, clienteTexto);

    const total = redondear2(items.reduce((acc, it) => acc + it.subtotal, 0));
    const fechaVenta = fecha || fechaInput(venta.fecha);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cfgStock = await obtenerConfigStock(client);
      await client.query(
        'update ventas set cliente_id=$1, fecha=$2, forma_pago=$3, origen=$4, notas=$5, total=$6 where id=$7',
        [cliente_id, fechaVenta, forma_pago, origen, notas || null, total, venta.id]
      );
      const { rows: itemsViejos } = await client.query(
        'select articulo_id, cantidad from ventas_items where venta_id = $1',
        [venta.id]
      );
      if (cfgStock.modo === 'automatico') {
        for (const it of itemsViejos) {
          await registrarMovimiento(client, {
            articuloId: it.articulo_id,
            tipo: 'venta_eliminada',
            cantidad: it.cantidad,
            usuarioId: req.session.usuario.id,
            ventaId: venta.id,
          });
        }
      }
      await client.query('delete from ventas_items where venta_id = $1', [venta.id]);
      for (const it of items) {
        await client.query(
          `insert into ventas_items (venta_id, articulo_id, cantidad, precio_unitario, subtotal)
           values ($1,$2,$3,$4,$5)`,
          [venta.id, it.articulo_id, it.cantidad, it.precio_unitario, it.subtotal]
        );
        if (cfgStock.modo === 'automatico') {
          await registrarMovimiento(client, {
            articuloId: it.articulo_id,
            tipo: 'venta',
            cantidad: -it.cantidad,
            usuarioId: req.session.usuario.id,
            ventaId: venta.id,
          });
        }
      }
      await sincronizarMovimientoVenta(client, {
        id: venta.id,
        cliente_id,
        fecha: fechaVenta,
        forma_pago,
        total,
        numero_remito: venta.numero_remito,
      });
      await client.query('COMMIT');
      res.redirect(`/ventas/${venta.id}`);
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
      `select v.*, c.razon_social as cliente_nombre, c.direccion as cliente_direccion,
              c.telefono as cliente_telefono, c.cuit_dni as cliente_cuit_dni,
              c.condicion_iva as cliente_condicion_iva
       from ventas v join clientes c on c.id = v.cliente_id
       where v.id = $1`,
      [req.params.id]
    );
    const venta = rows[0];
    if (!venta) return res.redirect('/ventas');
    const { rows: items } = await pool.query(
      `select i.*, a.codigo, a.nombre
       from ventas_items i join articulos a on a.id = i.articulo_id
       where i.venta_id = $1
       order by i.id`,
      [venta.id]
    );
    res.render('ventas/detalle', { venta, items });
  } catch (err) { next(err); }
});

router.post('/:id/estado', async (req, res, next) => {
  try {
    const estado = ESTADOS.includes(req.body.estado) ? req.body.estado : null;
    if (estado) {
      await pool.query('update ventas set estado = $1 where id = $2', [estado, req.params.id]);
    }
    res.redirect(`/ventas/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/eliminar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfgStock = await obtenerConfigStock(client);
    const { rows: itemsViejos } = await client.query(
      'select articulo_id, cantidad from ventas_items where venta_id = $1',
      [req.params.id]
    );
    if (cfgStock.modo === 'automatico') {
      for (const it of itemsViejos) {
        await registrarMovimiento(client, {
          articuloId: it.articulo_id,
          tipo: 'venta_eliminada',
          cantidad: it.cantidad,
          usuarioId: req.session.usuario.id,
          ventaId: req.params.id,
        });
      }
    }
    // ventas_items tiene "on delete cascade" sobre venta_id, así que se
    // borran solos los renglones de esta venta.
    await client.query('delete from ventas where id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.redirect('/ventas');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
