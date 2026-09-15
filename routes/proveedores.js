// Proveedores — alta, edición y listado. Se usa desde Compras para elegir
// a quién se le está comprando en cada factura.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from proveedores order by nombre');
    res.render('proveedores/lista', { proveedores: rows, error: req.query.error || null });
  } catch (err) { next(err); }
});

router.get('/nuevo', (req, res) => {
  res.render('proveedores/form', { proveedor: {}, accion: '/compras/proveedores', error: null });
});

router.post('/', async (req, res, next) => {
  try {
    const p = req.body;
    if (!p.nombre || !p.nombre.trim()) {
      return res.render('proveedores/form', {
        proveedor: p,
        accion: '/compras/proveedores',
        error: 'Falta el nombre del proveedor.',
      });
    }
    await pool.query(
      'insert into proveedores (nombre, contacto, telefono) values ($1,$2,$3)',
      [p.nombre.trim(), p.contacto || null, p.telefono || null]
    );
    res.redirect('/compras/proveedores');
  } catch (err) { next(err); }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from proveedores where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/compras/proveedores');
    res.render('proveedores/form', { proveedor: rows[0], accion: `/compras/proveedores/${req.params.id}`, error: null });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const p = req.body;
    if (!p.nombre || !p.nombre.trim()) {
      return res.render('proveedores/form', {
        proveedor: { ...p, id: req.params.id },
        accion: `/compras/proveedores/${req.params.id}`,
        error: 'Falta el nombre del proveedor.',
      });
    }
    await pool.query(
      'update proveedores set nombre=$1, contacto=$2, telefono=$3 where id=$4',
      [p.nombre.trim(), p.contacto || null, p.telefono || null, req.params.id]
    );
    res.redirect('/compras/proveedores');
  } catch (err) { next(err); }
});

// No se borra si tiene facturas de compra cargadas: el listado y el
// detalle de esas facturas dependen de un join con proveedores, así que
// perder la referencia rompería el historial (y de paso, el nombre del
// proveedor de esa factura vieja).
router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select count(*)::int as cantidad from facturas_compra where proveedor_id = $1',
      [req.params.id]
    );
    const cantidad = rows[0].cantidad;
    if (cantidad > 0) {
      const msg = `No se puede eliminar: tiene ${cantidad} factura${cantidad > 1 ? 's' : ''} de compra cargada${cantidad > 1 ? 's' : ''}.`;
      return res.redirect('/compras/proveedores?error=' + encodeURIComponent(msg));
    }
    await pool.query('delete from proveedores where id = $1', [req.params.id]);
    res.redirect('/compras/proveedores');
  } catch (err) { next(err); }
});

module.exports = router;
