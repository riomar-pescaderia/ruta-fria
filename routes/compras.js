// Compras — facturas de proveedores. Una factura de "mercadería" arranca
// como borrador (se puede seguir editando) y al confirmarla pisa el
// costo de cada artículo con el precio unitario cargado en esa línea —
// a partir de ahí queda de solo lectura, para no perder el historial de
// qué costo regía en cada momento. Un comprobante de cualquier otra
// categoría (servicios, insumos, alquileres, etc.) no tiene artículos de
// stock ni costo que pisar, así que no pasa por ese paso de revisión: se
// carga a mano y queda siempre editable.
const express = require('express');
const pool = require('../db/pool');
const proveedoresRouter = require('./proveedores');
const { getConfig } = require('../lib/config');
const { puedeEditarConfirmadas } = require('../lib/auth');
const { CATEGORIAS_GASTO, esClaveValida, categoriaPorClave } = require('../lib/categoriasGasto');
const { registrarMovimiento } = require('../lib/stock');

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

// La categoría manda: "mercaderia" es la única con artículos reales del
// catálogo. Si viene una clave desconocida (o ninguna) se usa
// "mercaderia" como valor seguro — es el comportamiento que tenía el
// sistema antes de que existiera esta categorización.
function leerCategoria(body) {
  return esClaveValida(body.categoria) ? body.categoria : 'mercaderia';
}

// El subtipo es opcional y depende de la categoría: si no es uno de los
// que esa categoría admite (o la categoría no tiene subtipos), se guarda
// null en vez de dejar pasar cualquier texto suelto.
function leerSubtipo(body, categoria) {
  const cat = categoriaPorClave(categoria);
  const subtipo = (body.subtipo || '').trim();
  if (!cat || !subtipo || !cat.subtipos.includes(subtipo)) return null;
  return subtipo;
}

// Lee los renglones que vienen del formulario (items[0][...], items[1][...]),
// descarta los incompletos (fila vacía que quedó de sobra) y calcula el
// precio final, el total y el desglose neto/IVA de cada uno. El
// "precio_unitario" del resultado es tal cual se tipeó (para poder
// volver a mostrarlo si hay que reabrir el formulario); el precio final
// ya calculado va en "precio_final", que es lo que se guarda como costo
// real del renglón.
//
// En "mercaderia" el renglón tiene que traer un articulo_id real del
// catálogo (se descarta si no). En cualquier otra categoría no hay
// artículo: el renglón se identifica por la descripción tipeada a mano
// (el código manual es opcional, solo para referencia).
function leerItems(body, ivaPct, categoria) {
  const raw = body.items;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  const esMercaderia = categoria === 'mercaderia';
  return arr
    .filter((it) => it && (esMercaderia ? it.articulo_id : (it.descripcion && it.descripcion.trim())))
    .map((it) => {
      const cantidad = redondear2(Number(it.cantidad) || 0);
      const precioIngresado = redondear2(Number(it.precio_unitario) || 0);
      const sumarIva = it.aplica_iva === 'on';
      const { precioFinal, total, neto, iva } = calcularItem(cantidad, precioIngresado, sumarIva, ivaPct);
      return {
        articulo_id: esMercaderia ? it.articulo_id : null,
        codigo_manual: esMercaderia ? null : ((it.codigo_manual || '').trim() || null),
        descripcion: esMercaderia ? null : it.descripcion.trim(),
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
    res.render('compras/lista', { facturas, categorias: CATEGORIAS_GASTO });
  } catch (err) { next(err); }
});

router.get('/nueva', async (req, res, next) => {
  try {
    const [{ proveedores, articulos }, config] = await Promise.all([datosFormulario(), getConfig()]);
    res.render('compras/form', {
      factura: { fecha: hoyAr(), categoria: 'mercaderia', subtipo: null },
      items: [{}],
      proveedores,
      articulos,
      categorias: CATEGORIAS_GASTO,
      ivaPct: config.iva_pct,
      error: null,
      accion: '/compras',
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { proveedor_id, numero, fecha } = req.body;
  const categoria = leerCategoria(req.body);
  const subtipo = leerSubtipo(req.body, categoria);
  let config, items;
  try {
    config = await getConfig();
    items = leerItems(req.body, config.iva_pct, categoria);
  } catch (err) { return next(err); }

  if (!proveedor_id || items.length === 0) {
    try {
      const { proveedores, articulos } = await datosFormulario();
      return res.render('compras/form', {
        factura: { proveedor_id, numero, fecha, categoria, subtipo },
        items: items.length ? items : [{}],
        proveedores,
        articulos,
        categorias: CATEGORIAS_GASTO,
        ivaPct: config.iva_pct,
        error: !proveedor_id
          ? 'Elegí un proveedor.'
          : 'Agregá al menos un renglón con cantidad y precio mayores a 0' + (categoria === 'mercaderia' ? ', con un artículo elegido.' : '.'),
        accion: '/compras',
      });
    } catch (err) { return next(err); }
  }

  const total = redondear2(items.reduce((acc, it) => acc + it.total, 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into facturas_compra (proveedor_id, numero, fecha, total, categoria, subtipo)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [proveedor_id, numero || null, fecha || hoyAr(), total, categoria, subtipo]
    );
    const facturaId = rows[0].id;
    for (const it of items) {
      await client.query(
        `insert into facturas_compra_items (factura_id, articulo_id, codigo_manual, descripcion, cantidad, precio_unitario, aplica_iva, total, neto, iva)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [facturaId, it.articulo_id, it.codigo_manual, it.descripcion, it.cantidad, it.precio_final, it.aplica_iva, it.total, it.neto, it.iva]
      );
    }
    await client.query('COMMIT');
    // Solo "mercadería" pasa por la revisión de precios — es el único
    // caso donde cargar la factura puede pisar el costo de un artículo.
    res.redirect(categoria === 'mercaderia' ? `/compras/${facturaId}/confirmar` : `/compras/${facturaId}`);
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
      categorias: CATEGORIAS_GASTO,
      ivaPct: config.iva_pct,
      error: null,
      accion: `/compras/${factura.id}`,
    });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  const { proveedor_id, numero, fecha } = req.body;
  const categoria = leerCategoria(req.body);
  const subtipo = leerSubtipo(req.body, categoria);
  let config, items;
  try {
    config = await getConfig();
    items = leerItems(req.body, config.iva_pct, categoria);
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
        factura: { id: factura.id, proveedor_id, numero, fecha, categoria, subtipo, actualizo_costos: factura.actualizo_costos },
        items: items.length ? items : [{}],
        proveedores,
        articulos,
        categorias: CATEGORIAS_GASTO,
        ivaPct: config.iva_pct,
        error: !proveedor_id
          ? 'Elegí un proveedor.'
          : 'Agregá al menos un renglón con cantidad y precio mayores a 0' + (categoria === 'mercaderia' ? ', con un artículo elegido.' : '.'),
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
      'update facturas_compra set proveedor_id=$1, numero=$2, fecha=$3, total=$4, categoria=$5, subtipo=$6 where id=$7',
      [proveedor_id, numero || null, fecha || fechaInput(factura.fecha), total, categoria, subtipo, factura.id]
    );
    await client.query('delete from facturas_compra_items where factura_id = $1', [factura.id]);
    for (const it of items) {
      await client.query(
        `insert into facturas_compra_items (factura_id, articulo_id, codigo_manual, descripcion, cantidad, precio_unitario, aplica_iva, total, neto, iva)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [factura.id, it.articulo_id, it.codigo_manual, it.descripcion, it.cantidad, it.precio_final, it.aplica_iva, it.total, it.neto, it.iva]
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
      `select i.*, coalesce(a.codigo, i.codigo_manual) as codigo, coalesce(a.nombre, i.descripcion) as nombre
       from facturas_compra_items i left join articulos a on a.id = i.articulo_id
       where i.factura_id = $1
       order by i.id`,
      [factura.id]
    );
    res.render('compras/detalle', { factura, items, categorias: CATEGORIAS_GASTO });
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
    // Solo "mercadería" pasa por acá — es la única categoría con costo de
    // artículo que revisar y, eventualmente, pisar.
    if (factura.categoria !== 'mercaderia') return res.redirect(`/compras/${factura.id}`);
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
    if (factura.categoria !== 'mercaderia') return res.redirect(`/compras/${factura.id}`);
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
      // El stock entra siempre con la mercadería confirmada, más allá de
      // si ese renglón en particular termina pisando el costo o no — son
      // dos decisiones independientes.
      await registrarMovimiento(client, {
        articuloId: it.articulo_id,
        tipo: 'compra',
        cantidad: it.cantidad,
        usuarioId: req.session.usuario.id,
        facturaId: factura.id,
      });
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
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select actualizo_costos from facturas_compra where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/compras');
    if (rows[0].actualizo_costos && !puedeEditarConfirmadas(req.session.usuario)) {
      return res.redirect(`/compras/${req.params.id}`);
    }

    await client.query('BEGIN');
    // Si la factura ya había confirmado mercadería, revertir el stock que
    // entró en ese momento antes de borrarla (mismo espíritu que en
    // ventas: el movimiento se deshace, no se recalcula nada más).
    if (rows[0].actualizo_costos) {
      const { rows: items } = await client.query(
        'select articulo_id, cantidad from facturas_compra_items where factura_id = $1 and articulo_id is not null',
        [req.params.id]
      );
      for (const it of items) {
        await registrarMovimiento(client, {
          articuloId: it.articulo_id,
          tipo: 'compra_eliminada',
          cantidad: -it.cantidad,
          usuarioId: req.session.usuario.id,
          facturaId: req.params.id,
        });
      }
    }
    await client.query('delete from facturas_compra where id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.redirect('/compras');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
