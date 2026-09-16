const express = require('express');
const pool = require('../db/pool');
const { geocodificarDireccion, buscarDirecciones } = require('../lib/geocode');
const { vincularProspectosDeCliente, buscarProspectosPorDomicilio } = require('../lib/vinculacion');

const router = express.Router();

function redondearCoord(n) {
  return n === null || n === undefined || n === '' ? null : Number(n);
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from clientes order by razon_social');
    res.render('clientes/lista', {
      clientes: rows,
      error: req.query.error || null,
      vinculoSugerido: req.query.vinculo_sugerido || null,
    });
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
    let lat = redondearCoord(c.lat);
    let lng = redondearCoord(c.lng);
    // Igual que en Historial de visitas: si el formulario no llegó con
    // coordenadas, se intenta geocodificar una vez más del lado del
    // servidor antes de guardar sin ubicación.
    if ((lat === null || lng === null) && c.direccion && c.direccion.trim()) {
      const geo = await geocodificarDireccion(c.direccion);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }
    const { rows } = await pool.query(
      `insert into clientes
        (razon_social, nombre_contacto, telefono, direccion, condicion_iva, cuit_dni, condicion_pago, notas, lat, lng)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [c.razon_social, c.nombre_contacto, c.telefono, c.direccion, c.condicion_iva, c.cuit_dni, c.condicion_pago, c.notas, lat, lng]
    );
    // Si este negocio ya estaba cargado como prospecto en Historial de
    // visitas (mismo CUIT/DNI o mismo teléfono), se vincula solo — ver
    // lib/vinculacion.js. Una coincidencia por domicilio no es tan segura
    // como para vincular sola: se ofrece como cartel al volver al listado
    // (ver /clientes/:id/sugerencias-domicilio, usado desde clientes/lista).
    await vincularProspectosDeCliente(rows[0].id);
    res.redirect(`/clientes?vinculo_sugerido=${rows[0].id}`);
  } catch (err) { next(err); }
});

// Usado desde el formulario (JS) para buscar la dirección tipeada antes de
// guardar, sin recargar la página — mismo endpoint que Historial de
// visitas, misma lógica (ver lib/geocode.js). Va antes de las rutas
// "/:id..." para que Express no confunda la palabra "geocodificar" con un
// id de cliente.
router.post('/geocodificar', async (req, res) => {
  const opciones = await buscarDirecciones(req.body.direccion, 5);
  if (opciones.length === 0) {
    return res.status(404).json({ error: 'No se encontró esa dirección. Marcá el punto a mano en el mapa.' });
  }
  res.json({ opciones });
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from clientes where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/clientes');
    res.render('clientes/form', { cliente: rows[0], accion: `/clientes/${req.params.id}` });
  } catch (err) { next(err); }
});

// Prospectos sin vincular que quedaron en el mismo domicilio que este
// cliente — se consulta por JS al volver al listado (después de crear o
// editar un cliente) para mostrar el cartel de "¿es el mismo negocio?".
router.get('/:id/sugerencias-domicilio', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select id, razon_social, direccion, lat, lng from clientes where id = $1', [req.params.id]);
    const cliente = rows[0];
    if (!cliente) return res.json({ sugerencias: [] });
    const sugerencias = await buscarProspectosPorDomicilio(cliente);
    res.json({ sugerencias, cliente: { id: cliente.id, razon_social: cliente.razon_social } });
  } catch (err) { next(err); }
});

// Confirma, desde el cartel de "posible vínculo por domicilio", que un
// prospecto sin vincular es en realidad este cliente.
router.post('/:id/vincular-prospecto', async (req, res, next) => {
  try {
    const prospectoId = req.body.prospecto_id;
    if (prospectoId) {
      await pool.query(
        'update prospectos set cliente_id = $1 where id = $2 and activo = true and cliente_id is null',
        [req.params.id, prospectoId]
      );
    }
    res.redirect('/clientes');
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const c = req.body;
    let lat = redondearCoord(c.lat);
    let lng = redondearCoord(c.lng);
    if ((lat === null || lng === null) && c.direccion && c.direccion.trim()) {
      const geo = await geocodificarDireccion(c.direccion);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }
    await pool.query(
      `update clientes set razon_social=$1, nombre_contacto=$2, telefono=$3, direccion=$4,
        condicion_iva=$5, cuit_dni=$6, condicion_pago=$7, notas=$8, lat=$9, lng=$10 where id=$11`,
      [c.razon_social, c.nombre_contacto, c.telefono, c.direccion, c.condicion_iva, c.cuit_dni, c.condicion_pago, c.notas, lat, lng, req.params.id]
    );
    // Por si recién ahora se completó el CUIT/DNI o el teléfono y eso
    // permite reconocer un prospecto que antes no se pudo vincular solo.
    await vincularProspectosDeCliente(req.params.id);
    res.redirect(`/clientes?vinculo_sugerido=${req.params.id}`);
  } catch (err) { next(err); }
});

// No se borra si el cliente ya tiene ventas, recibos, ajustes de cuenta
// corriente o un prospecto vinculado — perder esa referencia rompería el
// historial de esos registros (y el nombre que mostraban en ese momento).
// Ojo: un prospecto "eliminado" desde Historial de visitas no se borra de
// verdad (queda con activo = false, para no perder su historial de
// visitas) — así que ese vínculo ya no cuenta para bloquear el borrado
// del cliente, o quedaría bloqueado para siempre sin ninguna forma de
// arreglarlo desde la interfaz.
router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const [{ rows: enVentas }, { rows: enRecibos }, { rows: enMovimientos }, { rows: enProspectos }] = await Promise.all([
      pool.query('select count(*)::int as cantidad from ventas where cliente_id = $1', [req.params.id]),
      pool.query('select count(*)::int as cantidad from recibos where cliente_id = $1', [req.params.id]),
      pool.query("select count(*)::int as cantidad from cuenta_corriente_movimientos where cliente_id = $1 and tipo = 'ajuste'", [req.params.id]),
      pool.query('select count(*)::int as cantidad from prospectos where cliente_id = $1 and activo = true', [req.params.id]),
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
