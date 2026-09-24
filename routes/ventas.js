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
//
// Aparte de la forma de pago (que solo define el precio sugerido) queda
// registrado CÓMO se cobra de verdad, en ventas_pagos: uno o más medios,
// cada uno con su monto, que entre todos tienen que sumar el total de la
// venta — así se puede anotar, por ejemplo, una parte en efectivo y el
// resto por transferencia (o el resto directo a cuenta corriente). Ver
// leerMedios/errorMedios más abajo, y ventas_pagos en db/schema.sql.
const express = require('express');
const pool = require('../db/pool');
const { getConfig } = require('../lib/config');
const { calcularPrecios } = require('../lib/precios');
const { sincronizarMovimientoVenta } = require('../lib/cuentaCorriente');
const { registrarMovimiento, obtenerConfigStock } = require('../lib/stock');
const { fechaHoraInput, inputAFecha } = require('../lib/fechas');
const presupuestosRouter = require('./presupuestos');

const router = express.Router();

// Va antes que cualquier ruta "/:id" de acá abajo — si no, Express
// interpretaría "/presupuestos" como un intento de abrir la venta con
// id "presupuestos" en vez de entrar al router de presupuestos.
router.use('/presupuestos', presupuestosRouter);

const FORMAS_PAGO = ['efectivo', 'transferencia', 'cuenta_corriente'];
const MEDIOS_PAGO = FORMAS_PAGO; // mismas opciones — ver ventas_pagos en db/schema.sql
const ESTADOS = ['emitido', 'entregado', 'cobrado'];

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

async function datosFormulario() {
  const [{ rows: clientes }, { rows: articulosRaw }, config, { rows: usuarios }] = await Promise.all([
    pool.query('select * from clientes order by razon_social'),
    pool.query(`select * from articulos where activo = true order by
      case when codigo ~ '^[0-9]+$' then 0 else 1 end,
      case when codigo ~ '^[0-9]+$' then codigo::numeric end,
      codigo`),
    getConfig(),
    // Solo usuarios activos, para elegir quién realizó la venta — igual
    // que con clientes/artículos, no tiene sentido ofrecer para elegir a
    // alguien dado de baja.
    pool.query('select id, nombre, username from usuarios where activo = true order by nombre, username'),
  ]);
  const articulos = articulosRaw.map((a) => ({ ...a, ...calcularPrecios(a, config) }));
  return { clientes, articulos, usuarios };
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

// Lee los medios de pago del formulario (medios[0][...], medios[1][...])
// — mismo patrón que leerItems. Descarta filas sin medio elegido o con
// monto en 0 o menos (una fila que se agregó de más y se dejó vacía, por
// ejemplo). La suma de lo que queda se valida contra el total de la
// venta más abajo, antes de guardar nada.
function leerMedios(body) {
  const raw = body.medios;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr
    .filter((m) => m && m.medio_pago)
    .map((m) => ({
      medio_pago: MEDIOS_PAGO.includes(m.medio_pago) ? m.medio_pago : null,
      monto: redondear2(Number(m.monto) || 0),
    }))
    .filter((m) => m.medio_pago && m.monto > 0);
}

// La suma de los medios de pago tiene que coincidir con el total de la
// venta (con un margen mínimo por redondeo de centavos) — si no, no se
// deja guardar. Devuelve el mensaje de error, o null si está todo bien.
function errorMedios(medios, total) {
  if (medios.length === 0) return 'Agregá al menos un medio de pago.';
  const suma = redondear2(medios.reduce((acc, m) => acc + m.monto, 0));
  if (Math.abs(suma - total) > 0.005) {
    return `Los medios de pago suman $${suma.toFixed(2)}, pero el total de la venta es $${total.toFixed(2)}. Ajustá los montos para que coincidan.`;
  }
  return null;
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
    const { clientes, articulos, usuarios } = await datosFormulario();
    res.render('ventas/form', {
      // Por defecto el vendedor es quien está cargando la venta — se puede
      // cambiar igual, por si alguien carga a nombre de otro.
      venta: { fecha: fechaHoraInput(), forma_pago: 'efectivo', vendedor_id: req.session.usuario.id },
      items: [{}],
      medios: [{ medio_pago: 'efectivo', monto: '' }],
      clientes,
      articulos,
      usuarios,
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
  const vendedor_id = req.body.vendedor_id ? Number(req.body.vendedor_id) || null : null;
  const items = leerItems(req.body);
  const medios = leerMedios(req.body);

  if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
    try {
      const { clientes, articulos, usuarios } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, vendedor_id, notas },
        items: items.length ? items : [{}],
        medios: medios.length ? medios : [{ medio_pago: req.body.forma_pago || 'efectivo', monto: '' }],
        clientes,
        articulos,
        usuarios,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: '/ventas',
      });
    } catch (err) { return next(err); }
  }

  const total = redondear2(items.reduce((acc, it) => acc + it.subtotal, 0));

  // La suma de los medios de pago tiene que coincidir con el total de la
  // venta — si no, se corta acá, antes de tocar el cliente o la base.
  const errMedios = errorMedios(medios, total);
  if (errMedios) {
    try {
      const { clientes, articulos, usuarios } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { cliente_id, cliente_texto: clienteTexto, fecha, forma_pago, vendedor_id, notas },
        items,
        medios: medios.length ? medios : [{ medio_pago: forma_pago, monto: total }],
        clientes,
        articulos,
        usuarios,
        error: errMedios,
        accion: '/ventas',
      });
    } catch (err) { return next(err); }
  }

  try {
    cliente_id = await resolverClienteId(cliente_id, clienteTexto);
  } catch (err) { return next(err); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfgStock = await obtenerConfigStock(client);
    const fechaVenta = inputAFecha(fecha) || new Date();
    const { rows } = await client.query(
      `insert into ventas (cliente_id, fecha, forma_pago, vendedor_id, notas, total)
       values ($1,$2,$3,$4,$5,$6) returning id, numero_remito`,
      [cliente_id, fechaVenta, forma_pago, vendedor_id, notas || null, total]
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
    for (let i = 0; i < medios.length; i++) {
      await client.query(
        `insert into ventas_pagos (venta_id, medio_pago, monto, orden) values ($1,$2,$3,$4)`,
        [ventaId, medios[i].medio_pago, medios[i].monto, i]
      );
    }
    const montoCuentaCorriente = redondear2(
      medios.filter((m) => m.medio_pago === 'cuenta_corriente').reduce((acc, m) => acc + m.monto, 0)
    );
    await sincronizarMovimientoVenta(client, {
      id: ventaId,
      cliente_id,
      fecha: fechaVenta,
      total,
      numero_remito: rows[0].numero_remito,
      montoCuentaCorriente,
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
    const [{ rows: items }, { rows: medios }] = await Promise.all([
      pool.query('select * from ventas_items where venta_id = $1 order by id', [venta.id]),
      pool.query('select * from ventas_pagos where venta_id = $1 order by orden, id', [venta.id]),
    ]);
    const { clientes, articulos, usuarios } = await datosFormulario();
    res.render('ventas/form', {
      venta: { ...venta, fecha: fechaHoraInput(venta.fecha) },
      items,
      // Por si una venta muy vieja quedara sin ningún medio cargado (no
      // debería pasar — la migración de db/schema.sql le arma uno a cada
      // venta ya existente) se arranca igual con un medio por defecto, en
      // vez de dejar el formulario sin ninguna fila.
      medios: medios.length ? medios : [{ medio_pago: venta.forma_pago, monto: venta.total }],
      clientes,
      articulos,
      usuarios,
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
  const vendedor_id = req.body.vendedor_id ? Number(req.body.vendedor_id) || null : null;
  const items = leerItems(req.body);
  const medios = leerMedios(req.body);

  try {
    const { rows } = await pool.query('select * from ventas where id = $1', [req.params.id]);
    const venta = rows[0];
    if (!venta) return res.redirect('/ventas');

    if ((!cliente_id && !clienteTexto) || !forma_pago || items.length === 0) {
      const { clientes, articulos, usuarios } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { id: venta.id, cliente_id, cliente_texto: clienteTexto, fecha, forma_pago: req.body.forma_pago, vendedor_id, notas },
        items: items.length ? items : [{}],
        medios: medios.length ? medios : [{ medio_pago: req.body.forma_pago || 'efectivo', monto: '' }],
        clientes,
        articulos,
        usuarios,
        error: (!cliente_id && !clienteTexto)
          ? 'Elegí un cliente o escribí su nombre.'
          : !forma_pago
          ? 'Elegí una forma de pago.'
          : 'Agregá al menos un renglón con artículo, cantidad y precio mayores a 0.',
        accion: `/ventas/${venta.id}`,
      });
    }

    const total = redondear2(items.reduce((acc, it) => acc + it.subtotal, 0));

    const errMedios = errorMedios(medios, total);
    if (errMedios) {
      const { clientes, articulos, usuarios } = await datosFormulario();
      return res.render('ventas/form', {
        venta: { id: venta.id, cliente_id, cliente_texto: clienteTexto, fecha, forma_pago, vendedor_id, notas },
        items,
        medios: medios.length ? medios : [{ medio_pago: forma_pago, monto: total }],
        clientes,
        articulos,
        usuarios,
        error: errMedios,
        accion: `/ventas/${venta.id}`,
      });
    }

    cliente_id = await resolverClienteId(cliente_id, clienteTexto);

    const fechaVenta = inputAFecha(fecha) || venta.fecha;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cfgStock = await obtenerConfigStock(client);
      await client.query(
        'update ventas set cliente_id=$1, fecha=$2, forma_pago=$3, vendedor_id=$4, notas=$5, total=$6 where id=$7',
        [cliente_id, fechaVenta, forma_pago, vendedor_id, notas || null, total, venta.id]
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
      await client.query('delete from ventas_pagos where venta_id = $1', [venta.id]);
      for (let i = 0; i < medios.length; i++) {
        await client.query(
          `insert into ventas_pagos (venta_id, medio_pago, monto, orden) values ($1,$2,$3,$4)`,
          [venta.id, medios[i].medio_pago, medios[i].monto, i]
        );
      }
      const montoCuentaCorriente = redondear2(
        medios.filter((m) => m.medio_pago === 'cuenta_corriente').reduce((acc, m) => acc + m.monto, 0)
      );
      await sincronizarMovimientoVenta(client, {
        id: venta.id,
        cliente_id,
        fecha: fechaVenta,
        total,
        numero_remito: venta.numero_remito,
        montoCuentaCorriente,
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
              c.condicion_iva as cliente_condicion_iva,
              coalesce(u.nombre, u.username) as vendedor_nombre
       from ventas v join clientes c on c.id = v.cliente_id
       left join usuarios u on u.id = v.vendedor_id
       where v.id = $1`,
      [req.params.id]
    );
    const venta = rows[0];
    if (!venta) return res.redirect('/ventas');
    const [{ rows: items }, { rows: pagos }] = await Promise.all([
      pool.query(
        `select i.*, a.codigo, a.nombre
         from ventas_items i join articulos a on a.id = i.articulo_id
         where i.venta_id = $1
         order by i.id`,
        [venta.id]
      ),
      pool.query('select * from ventas_pagos where venta_id = $1 order by orden, id', [venta.id]),
    ]);
    res.render('ventas/detalle', { venta, items, pagos });
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
