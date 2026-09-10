const express = require('express');
const pool = require('../db/pool');
const { getConfig } = require('../lib/config');
const { calcularPrecios } = require('../lib/precios');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [{ rows: articulos }, config] = await Promise.all([
      pool.query('select * from articulos order by nombre'),
      getConfig(),
    ]);
    const conPrecios = articulos.map((a) => ({ ...a, ...calcularPrecios(a, config) }));
    res.render('articulos/lista', { articulos: conPrecios, config });
  } catch (err) { next(err); }
});

router.get('/nuevo', (req, res) => {
  res.render('articulos/form', { articulo: {}, accion: '/articulos' });
});

router.post('/', async (req, res, next) => {
  try {
    const a = req.body;
    await pool.query(
      `insert into articulos (codigo, nombre, unidad, costo, aplica_iva, aplica_iibb, flete_pct, margen_pct, stock)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.codigo, a.nombre, a.unidad, a.costo || 0, !!a.aplica_iva, !!a.aplica_iibb, a.flete_pct || 0, a.margen_pct || 0, a.stock || null]
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
      [a.codigo, a.nombre, a.unidad, !!a.aplica_iva, !!a.aplica_iibb, a.flete_pct || 0, a.margen_pct || 0, a.stock || null, req.params.id]
    );
    res.redirect('/articulos');
  } catch (err) { next(err); }
});

module.exports = router;
