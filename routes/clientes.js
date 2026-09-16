const express = require('express');
const pool = require('../db/pool');
const { vincularProspectosDeCliente } = require('../lib/vinculacion');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from clientes order by razon_social');
    res.render('clientes/lista', { clientes: rows, error: req.query.error || null });
  } catch (err) { next(err); }
});

// Junta varios ítems en una sola frase en español ("A", "A y B", "A, B y C")
// para armar el mensaje de error de abajo.
function listarConY(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' y ' + items[items.length - 1];
}

router.get('/nuevo', (req, res) => {
  res.render('clientes/form', { cliente: {}, accion: '/clientes' });
});

router.post('/', async (req, res, next) => {
  try {
    const c = req.body;
    const { rows } = await pool.query(
      `insert into clientes
        (razon_social, nombre_contacto, telefono, direccion, condicion_iva, cuit_dni, condicion_pago, notas)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [c.razon_social, c.nombre_contacto, c.telefono, c.direccion, c.condicion_iva, c.cuit_dni, c.condicion_pago, c.notas]
    );
    // Si este negocio ya estaba cargado como prospecto en Historial de
    // visitas (mismo CUIT/DNI o mismo teléfono), se vincula solo — ver
    // lib/vinculacion.js.
    await vincularProspectosDeCliente(rows[0].id);
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
    // Por si recién ahora se completó el CUIT/DNI o el teléfono y eso
    // permite reconocer un prospecto que antes no se pudo vincular solo.
    await vincularProspectosDeCliente(req.params.id);
    res.redirect('/clientes');
  } catch (err) { next(err); }
});

// No se borra si el cliente ya tiene ventas, recibos, ajustes de cuenta
// corriente o un prospecto vinculado — perder esa referencia rompería el
// historial de esos registros (y el nombre que mostraban en ese momento).
router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const [{ rows: enVentas }, { rows: enRecibos }, { rows: enMovimientos }, { rows: enProspectos }] = await Promise.all([
      pool.query('select count(*)::int as cantidad from ventas where cliente_id = $1', [req.params.id]),
      pool.query('select count(*)::int as cantidad from recibos where cliente_id = $1', [req.params.id]),
      pool.query("select count(*)::int as cantidad from cuenta_corriente_movimientos where cliente_id = $1 and tipo = 'ajuste'", [req.params.id]),
      pool.query('select count(*)::int as cantidad from prospectos where cliente_id = $1', [req.params.id]),
    ]);
    const usos = [];
    if (enVentas[0].cantidad > 0) usos.push(`${enVentas[0].cantidad} venta${enVentas[0].cantidad > 1 ? 's' : ''}`);
    if (enRecibos[0].cantidad > 0) usos.push(`${enRecibos[0].cantidad} recibo${enRecibos[0].cantidad > 1 ? 's' : ''}`);
    if (enMovimientos[0].cantidad > 0) usos.push(`${enMovimientos[0].cantidad} ajuste${enMovimientos[0].cantidad > 1 ? 's' : ''} de cuenta corriente`);
    if (enProspectos[0].cantidad > 0) usos.push(`${enProspectos[0].cantidad} prospecto${enProspectos[0].cantidad > 1 ? 's' : ''} vinculado${enProspectos[0].cantidad > 1 ? 's' : ''}`);
    const totalUsos = enVentas[0].cantidad + enRecibos[0].cantidad + enMovimientos[0].cantidad + enProspectos[0].cantidad;
    if (totalUsos > 0) {
      const msg = `No se puede eliminar: tiene ${listarConY(usos)} cargado${totalUsos > 1 ? 's' : ''}.`;
      return res.redirect('/clientes?error=' + encodeURIComponent(msg));
    }
    await pool.query('delete from clientes where id = $1', [req.params.id]);
    res.redirect('/clientes');
  } catch (err) { next(err); }
});

module.exports = router;
