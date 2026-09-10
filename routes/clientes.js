const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from clientes order by razon_social');
    res.render('clientes/lista', { clientes: rows });
  } catch (err) { next(err); }
});

router.get('/nuevo', (req, res) => {
  res.render('clientes/form', { cliente: {}, accion: '/clientes' });
});

router.post('/', async (req, res, next) => {
  try {
    const c = req.body;
    await pool.query(
      `insert into clientes
        (razon_social, nombre_contacto, telefono, direccion, condicion_iva, cuit_dni, condicion_pago, notas)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.razon_social, c.nombre_contacto, c.telefono, c.direccion, c.condicion_iva, c.cuit_dni, c.condicion_pago, c.notas]
    );
    res.redirect('/clientes');
  } catch (err) { next(err); }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from clientes where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/clientes');
    res.render('clientes/form', { cliente: rows[0], accion: `/clientes/${req.params.id}` });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const c = req.body;
    await pool.query(
      `update clientes set razon_social=$1, nombre_contacto=$2, telefono=$3, direccion=$4,
        condicion_iva=$5, cuit_dni=$6, condicion_pago=$7, notas=$8 where id=$9`,
      [c.razon_social, c.nombre_contacto, c.telefono, c.direccion, c.condicion_iva, c.cuit_dni, c.condicion_pago, c.notas, req.params.id]
    );
    res.redirect('/clientes');
  } catch (err) { next(err); }
});

module.exports = router;
