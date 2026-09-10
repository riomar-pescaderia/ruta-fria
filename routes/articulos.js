const express = require('express');
const pool = require('../db/pool');
const { getConfig } = require('../lib/config');
const { calcularPrecios } = require('../lib/precios');
const { parseTabla } = require('../lib/csv');
const { parseNumeroAr } = require('../lib/numeros');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [{ rows: articulos }, config] = await Promise.all([
      pool.query(`select * from articulos
        order by
          case when codigo ~ '^[0-9]+$' then 0 else 1 end,
          case when codigo ~ '^[0-9]+$' then codigo::numeric end,
          codigo`),
      getConfig(),
    ]);
    const conPrecios = articulos.map((a) => ({ ...a, ...calcularPrecios(a, config) }));
    res.render('articulos/lista', { articulos: conPrecios, config });
  } catch (err) { next(err); }
});

router.get('/nuevo', (req, res) => {
  res.render('articulos/form', { articulo: {}, accion: '/articulos' });
});

router.get('/importar', (req, res) => {
  res.render('articulos/importar', { resultado: null, datos: '' });
});

router.post('/importar', async (req, res, next) => {
  const datos = req.body.datos || '';
  try {
    const { filas, columnasReconocidas } = parseTabla(datos);

    if (!columnasReconocidas.includes('codigo') || !columnasReconocidas.includes('nombre')) {
      return res.render('articulos/importar', {
        datos,
        resultado: {
          error: 'No encontré columnas de "código" y "nombre" en lo que pegaste — son las dos obligatorias. Revisá los encabezados de la primera fila.',
          columnasReconocidas,
        },
      });
    }

    let creados = 0;
    let actualizados = 0;
    const errores = [];

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const numeroFila = i + 2; // +1 por el encabezado, +1 porque i arranca en 0

      if (!f.codigo || !f.nombre) {
        errores.push(`Fila ${numeroFila}: falta código o nombre, se salteó.`);
        continue;
      }

      const costo = f.costo !== undefined ? parseNumeroAr(f.costo) : null;
      const unidad = f.unidad !== undefined ? parseNumeroAr(f.unidad) : null;
      const margenPct = f.margen_pct !== undefined ? parseNumeroAr(f.margen_pct) : null;
      const fletePctManual = f.flete_pct !== undefined ? parseNumeroAr(f.flete_pct) : null;
      const fleteMonto = f.flete_monto !== undefined ? parseNumeroAr(f.flete_monto) : null;
      const ivaMonto = f.iva_monto !== undefined ? parseNumeroAr(f.iva_monto) : null;
      const iibbMonto = f.iibb_monto !== undefined ? parseNumeroAr(f.iibb_monto) : null;

      if (f.costo !== undefined && costo === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): el costo "${f.costo}" no se entiende como número, se dejó en 0.`);
      }
      if (f.unidad !== undefined && unidad === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): la unidad "${f.unidad}" no se entiende como número, se dejó en 1.`);
      }
      if (f.margen_pct !== undefined && margenPct === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): el margen "${f.margen_pct}" no se entiende como número, se dejó en 0.`);
      }
      if (f.flete_monto !== undefined && fleteMonto === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): el flete "${f.flete_monto}" no se entiende como número, no se tocó el flete.`);
      }
      if (f.iva_monto !== undefined && ivaMonto === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): el IVA "${f.iva_monto}" no se entiende como número, no se tocó "Aplica IVA".`);
      }
      if (f.iibb_monto !== undefined && iibbMonto === null) {
        errores.push(`Fila ${numeroFila} (${f.codigo}): el IIBB "${f.iibb_monto}" no se entiende como número, no se tocó "Aplica IIBB".`);
      }

      // el monto de flete/IVA/IIBB de la planilla manda sobre flete_pct
      // manual si ambos vienen en la misma fila.
      const fletePct = fleteMonto !== null ? (fleteMonto > 0 ? 6 : 0) : fletePctManual;
      const aplicaIva = ivaMonto !== null ? ivaMonto > 0 : null;
      const aplicaIibb = iibbMonto !== null ? iibbMonto > 0 : null;

      const { rows } = await pool.query('select id from articulos where codigo = $1', [f.codigo]);

      if (rows[0]) {
        await pool.query(
          `update articulos set nombre=$1, unidad=coalesce($2, unidad),
             costo=coalesce($3, costo), margen_pct=coalesce($4, margen_pct), flete_pct=coalesce($5, flete_pct),
             aplica_iva=coalesce($6, aplica_iva), aplica_iibb=coalesce($7, aplica_iibb)
           where codigo=$8`,
          [f.nombre, unidad, costo, margenPct, fletePct, aplicaIva, aplicaIibb, f.codigo]
        );
        actualizados++;
      } else {
        await pool.query(
          `insert into articulos (codigo, nombre, unidad, costo, margen_pct, flete_pct, aplica_iva, aplica_iibb)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [f.codigo, f.nombre, unidad || 1, costo || 0, margenPct || 0, fletePct || 0, aplicaIva !== null ? aplicaIva : true, aplicaIibb !== null ? aplicaIibb : true]
        );
        creados++;
      }
    }

    res.render('articulos/importar', {
      datos: '',
      resultado: { creados, actualizados, errores, columnasReconocidas },
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const a = req.body;
    await pool.query(
      `insert into articulos (codigo, nombre, unidad, costo, aplica_iva, aplica_iibb, flete_pct, margen_pct, stock)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.codigo, a.nombre, a.unidad || 1, a.costo || 0, !!a.aplica_iva, !!a.aplica_iibb, a.flete_pct || 0, a.margen_pct || 0, a.stock || null]
    );
    res.redirect('/articulos');
  } catch (err) { next(err); }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from articulos where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/articulos');
    res.render('articulos/form', { articulo: rows[0], accion: `/articulos/${req.params.id}` });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const a = req.body;
    // el costo NO se edita a mano acá — llega desde Compras (facturas de proveedores)
    await pool.query(
      `update articulos set codigo=$1, nombre=$2, unidad=$3, aplica_iva=$4, aplica_iibb=$5,
        flete_pct=$6, margen_pct=$7, stock=$8 where id=$9`,
      [a.codigo, a.nombre, a.unidad || 1, !!a.aplica_iva, !!a.aplica_iibb, a.flete_pct || 0, a.margen_pct || 0, a.stock || null, req.params.id]
    );
    res.redirect('/articulos');
  } catch (err) { next(err); }
});

module.exports = router;
