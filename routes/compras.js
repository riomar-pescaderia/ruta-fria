// Compras — facturas de proveedores. Una factura arranca como borrador
// (se puede seguir editando) y al confirmarla pisa el costo de cada
// artículo con el precio unitario cargado en esa línea. Una vez
// confirmada queda de solo lectura, para no perder el historial de qué
// costo regía en cada momento.
const express = require('express');
const pool = require('../db/pool');
const proveedoresRouter = require('./proveedores');
const { getConfig } = require('../lib/config');
const { puedeEditarConfirmadas } = require('../lib/auth');

const router = express.Router();

router.use('/proveedores', proveedoresRouter);

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

// Hoy, en la zona horaria del negocio — para no depender de en qué huso
// horario esté corriendo el servidor (Render corre en UTC).
function hoyAr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Una columna "date" de Postgres vuelve como Date de JS (medianoche UTC) —
// esto la deja en el formato que espera un <input type="date">.
function fechaInput(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

async function datosFormulario() {
  const [{ rows: proveedores }, { rows: articulos }] = await Promise.all([
    pool.query('select * from proveedores order by nombre'),
    pool.query(`select * from articulos where activo = true order by
      case when codigo ~ '^[0-9]+$' then 0 else 1 end,
      case when codigo ~ '^[0-9]+$' then codigo::numeric end,
      codigo`),
  ]);
  return { proveedores, articulos };
}

// La casilla "IVA" de un renglón define qué es el precio unitario que se
// tipeó: tildada, es el precio SIN IVA y hay que sumárselo (el caso más
// común, como viene la mayoría de las facturas de compra); destildada, el
// precio ya viene con el IVA integrado y se usa tal cual. En los dos
// casos se devuelve el precio final (el costo real, con IVA ya sumado si
// correspondía) y el desglose neto/IVA de todo el renglón, calculado al
// %IVA vigente en config.
function calcularItem(cantidad, precioIngresado, sumarIva, ivaPct) {
  let precioFinal, total, neto, iva;
  if (sumarIva) {
    precioFinal = redondear2(precioIngresado * (1 + Number(ivaPct) / 100));
    total = redondear2(cantidad * precioFinal);
    neto = redondear2(cantidad * precioIngresado);
    iva = redondear2(total - neto);
  } else {
    precioFinal = precioIngresado;
    total = redondear2(cantidad * precioFinal);
    neto = redondear2(total / (1 + Number(ivaPct) / 100));
    iva = redondear2(total - neto);
  }
  return { precioFinal, total, neto, iva };
}

// Lee los renglones que vienen del formulario (items[0][...], items[1][...]),
// descarta los incompletos (fila vacía que quedó de sobra) y calcula el
// precio final, el total y el desglose neto/IVA de cada uno. El
// "precio_unitario" del resultado es tal cual se tipeó (para poder
// volver a mostrarlo si hay que reabrir el formulario); el precio final
// ya calculado va en "precio_final", que es lo que se guarda como costo
// real del renglón.
function leerItems(body, ivaPct) {
  const raw = body.items;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr
    .filter((it) => it && it.articulo_id)
    .map((it) => {
      const cantidad = redondear2(Number(it.cantidad) || 0);
      const precioIngresado = redondear2(Number(it.precio_unitario) || 0);
      const sumarIva = it.aplica_iva === 'on';
      const { precioFinal, total, neto, iva } = calcularItem(cantidad, precioIngresado, sumarIva, ivaPct);
      return {
        articulo_id: it.articulo_id,
        cantidad,
        precio_unitario: precioIngresado,
        precio_final: precioFinal,
        aplica_iva: sumarIva,
        total,
        neto,
        iva,
      };
    })
    .filter((it) => it.cantidad > 0 && it.precio_unitario > 0);
}

router.get('/', async (req, res, next) => {
  try {
    const { rows: facturas } = await pool.query(
      `select f.*, p.nombre as proveedor_nombre
       from facturas_compra f join proveedores p on p.id = f.proveedor_id
       order by f.fecha desc, f.id desc`
    );
    res.render('compras/lista', { facturas });
  } catch (err) { next(err); }
});

router.get('/nueva', async (req, res, next) => {
  try {
    const [{ proveedores, articulos }, config] = await Promise.all([datosFormulario(), getConfig()]);
    res.render('compras/form', {
      factura: { fecha: hoyAr() },
      items: [{}],
      proveedores,
      articulos,
      ivaPct: config.iva_pct,
      error: null,
      accion: '/compras',
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { proveedor_id, numero, fecha } = req.body;
  let config, items;
  try {
    config = await getConfig();
    items = leerItems(req.body, config.iva_pct);
  } catch (err) { return next(err); }

  if (!proveedor_id || items.length === 0) {
    try {
      const { proveedores, articulos } = await datosFormulario();
      return res.render('compras/form', {
        factura: { proveedor_id, numero, fecha },
        items: items.length ? items : [{}],
        proveedores,
        articulos,
        ivaPct: config.iva_pct,
        error: !proveedor_id ? 'Elegí un proveedor.' : 'Agregá al menos un artículo con cantidad y precio mayores a 0.',
        accion: '/compras',
      });
    } catch (err) { return next(err); }
  }

  const total = redondear2(items.reduce((acc, it) => acc + it.total, 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into facturas_compra (proveedor_id, numero, fecha, total)
       values ($1,$2,$3,$4) returning id`,
      [proveedor_id, numero || null, fecha || hoyAr(), total]
    );
    const facturaId = rows[0].id;
    for (const it of items) {
      await client.query(
        `insert into facturas_compra_items (factura_id, articulo_id, cantidad, precio_unitario, aplica_iva, total, neto, iva)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [facturaId, it.articulo_id, it.cantidad, it.precio_final, it.aplica_iva, it.total, it.neto, it.iva]
      );
    }
    await client.query('COMMIT');
    res.redirect(`/compras/${facturaId}/confirmar`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from facturas_compra where id = $1', [req.params.id]);
    const factura = rows[0];
    if (!factura) return res.redirect('/compras');
    if (factura.actualizo_costos && !puedeEditarConfirmadas(req.session.usuario)) {
      return res.redirect(`/compras/${factura.id}`);
    }

    const { rows: itemsGuardados } = await pool.query(
      'select * from facturas_compra_items where factura_id = $1 order by id',
      [factura.id]
    );
    const [{ proveedores, articulos }, config] = await Promise.all([datosFormulario(), getConfig()]);

    // El precio guardado siempre es el final (con IVA ya sumado si
    // correspondía) — para reabrir el formulario hay que reconstruir lo
    // que realmente se tipeó: si sumaba IVA, el neto guardado ÷ cantidad
    // es ese precio original; si no, el precio guardado ya era el que se
    // tipeó, sin transformar.
    const items = itemsGuardados.map((it) => ({
      ...it,
      precio_unitario: it.aplica_iva
        ? redondear2(Number(it.neto) / Number(it.cantidad))
        : Number(it.precio_unitario),
    }));

    res.render('compras/form', {
      factura: { ...factura, fecha: fechaInput(factura.fecha) },
      items,
      proveedores,
      articulos,
      ivaPct: config.iva_pct,
      error: null,
      accion: `/compras/${factura.id}`,
    });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  const { proveedor_id, numero, fecha } = req.body;
  let config, items;
  try {
    config = await getConfig();
    items = leerItems(req.body, config.iva_pct);
  } catch (err) { return next(err); }
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select * from facturas_compra where id = $1', [req.params.id]);
    const factura = rows[0];
    if (!factura) return res.redirect('/compras');
    if (factura.actualizo_costos && !puedeEditarConfirmadas(req.session.usuario)) {
      return res.redirect(`/compras/${factura.id}`);
    }

    if (!proveedor_id || items.length === 0) {
      const { proveedores, articulos } = await datosFormulario();
      return res.render('compras/form', {
        factura: { id: factura.id, proveedor_id, numero, fecha, actualizo_costos: factura.actualizo_costos },
        items: items.length ? items : [{}],
        proveedores,
        articulos,
        ivaPct: config.iva_pct,
        error: !proveedor_id ? 'Elegí un proveedor.' : 'Agregá al menos un artículo con cantidad y precio mayores a 0.',
        accion: `/compras/${factura.id}`,
      });
    }

    const total = redondear2(items.reduce((acc, it) => acc + it.total, 0));

    // Si es una corrección sobre una factura ya confirmada, no se vuelve a
    // pisar el costo de los artículos ni se repite el paso de revisión —
    // eso ya se decidió al confirmarla. Solo se corrige el registro de la
    // factura y sus renglones (por eso se pierde el detalle de qué
    // renglones habían aplicado costo, que quedaba en estado_costo).
    await client.query('BEGIN');
    await client.query(
      'update facturas_compra set proveedor_id=$1, numero=$2, fecha=$3, total=$4 where id=$5',
      [proveedor_id, numero || null, fecha || fechaInput(factura.fecha), total, factura.id]
    );
    await client.query('delete from facturas_compra_items where factura_id = $1', [factura.id]);
    for (const it of items) {
      await client.query(
        `insert into facturas_compra_items (factura_id, articulo_id, cantidad, precio_unitario, aplica_iva, total, neto, iva)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [factura.id, it.articulo_id, it.cantidad, it.precio_final, it.aplica_iva, it.total, it.neto, it.iva]
      );
    }
    await client.query('COMMIT');
    res.redirect(`/compras/${factura.id}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select f.*, p.nombre as proveedor_nombre
       from facturas_compra f join proveedores p on p.id = f.proveedor_id
       where f.id = $1`,
      [req.params.id]
    );
    const factura = rows[0];
    if (!factura) return res.redirect('/compras');

    const { rows: items } = await pool.query(
      `select i.*, a.codigo, a.nombre
       from facturas_compra_items i join articulos a on a.id = i.articulo_id
       where i.factura_id = $1
       order by i.id`,
      [factura.id]
    );
    res.render('compras/detalle', { factura, items });
  } catch (err) { next(err); }
});

// Pantalla de revisión: antes de confirmar, muestra para cada renglón el
// costo vigente del artículo contra el precio cargado en la factura, y
// deja elegir renglón por renglón si ese cambio de precio se aplica o no.
router.get('/:id/confirmar', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select f.*, p.nombre as proveedor_nombre
       from facturas_compra f join proveedores p on p.id = f.proveedor_id
       where f.id = $1`,
      [req.params.id]
    );
    const factura = rows[0];
    if (!factura) return res.redirect('/compras');
    if (factura.actualizo_costos) return res.redirect(`/compras/${factura.id}`);

    const { rows: items } = await pool.query(
      `select i.*, a.codigo, a.nombre, a.costo as costo_actual
       from facturas_compra_items i join articulos a on a.id = i.articulo_id
       where i.factura_id = $1
       order by i.id`,
      [factura.id]
    );
    if (items.length === 0) return res.redirect(`/compras/${factura.id}`);

    const itemsConCambio = items.map((it) => ({
      ...it,
      cambia: Number(it.costo_actual) !== Number(it.precio_unitario),
    }));

    res.render('compras/confirmar', { factura, items: itemsConCambio });
  } catch (err) { next(err); }
});

router.post('/:id/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select * from facturas_compra where id = $1', [req.params.id]);
    const factura = rows[0];
    if (!factura) return res.redirect('/compras');
    if (factura.actualizo_costos) return res.redirect(`/compras/${factura.id}`);

    const { rows: items } = await client.query(
      `select i.*, a.costo as costo_actual
       from facturas_compra_items i join articulos a on a.id = i.articulo_id
       where i.factura_id = $1`,
      [factura.id]
    );
    if (items.length === 0) return res.redirect(`/compras/${factura.id}`);

    // Qué renglones marcó el usuario para aplicar, en la pantalla de
    // revisión — llega como { "<item_id>": "on", ... }, solo con las
    // claves de los checkboxes tildados.
    const aplicar = req.body.aplicar || {};

    await client.query('BEGIN');
    for (const it of items) {
      const cambia = Number(it.costo_actual) !== Number(it.precio_unitario);
      if (!cambia) {
        await client.query('update facturas_compra_items set estado_costo = $1 where id = $2', ['sin_cambio', it.id]);
        continue;
      }
      if (aplicar[it.id] === 'on') {
        await client.query('update articulos set costo = $1 where id = $2', [it.precio_unitario, it.articulo_id]);
        await client.query('update facturas_compra_items set estado_costo = $1 where id = $2', ['aplicado', it.id]);
      } else {
        await client.query('update facturas_compra_items set estado_costo = $1 where id = $2', ['no_aplicado', it.id]);
      }
    }
    await client.query('update facturas_compra set actualizo_costos = true where id = $1', [factura.id]);
    await client.query('COMMIT');
    res.redirect(`/compras/${factura.id}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select actualizo_costos from facturas_compra where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/compras');
    if (rows[0].actualizo_costos && !puedeEditarConfirmadas(req.session.usuario)) {
      return res.redirect(`/compras/${req.params.id}`);
    }
    await pool.query('delete from facturas_compra where id = $1', [req.params.id]);
    res.redirect('/compras');
  } catch (err) { next(err); }
});

module.exports = router;
