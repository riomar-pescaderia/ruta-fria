// Historial de visitas a potenciales clientes (prospectos) — separado de
// Clientes a propósito: acá se cargan direcciones de gente que todavía no
// compró, para planificar y llevar registro de las visitas que se les
// hacen. El mapa que muestra cada punto vive acá mismo, en /prospectos/mapa
// (antes fue una sección aparte con permiso propio; se volvió a unificar).
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { geocodificarDireccion, buscarDirecciones } = require('../lib/geocode');
const { listarConVisitas } = require('../lib/prospectosCompartido');
const { buscarClienteCoincidente, buscarSugerenciasCliente } = require('../lib/vinculacion');
const { inputAFecha, fechaHoraInput, hoyAr } = require('../lib/fechas');
const { requireAdmin } = require('../lib/auth');

function redondearCoord(n) {
  return n === null || n === undefined || n === '' ? null : Number(n);
}

async function listarClientes() {
  const { rows } = await pool.query('select id, razon_social, cuit_dni from clientes order by razon_social');
  return rows;
}

// El formulario manda los contactos como listas paralelas
// (contacto_nombre[], contacto_telefono[]) — una posición por fila. El
// parser de body (qs, con "extended: true" en server.js) ya interpreta esa
// notación con corchetes como un array y lo deja en la clave SIN los
// corchetes (body.contacto_nombre, no body['contacto_nombre[]']) — antes
// se leía la clave con corchetes, que nunca existía, así que los contactos
// quedaban vacíos aunque se hubieran tipeado. Se arma un array de
// {nombre, telefono} descartando las filas totalmente vacías (p. ej. una
// fila que se agregó de más y se dejó sin completar).
function leerContactos(body) {
  let nombres = body.contacto_nombre;
  let telefonos = body.contacto_telefono;
  if (nombres === undefined && telefonos === undefined) return [];
  if (!Array.isArray(nombres)) nombres = nombres === undefined ? [] : [nombres];
  if (!Array.isArray(telefonos)) telefonos = telefonos === undefined ? [] : [telefonos];
  const cantidad = Math.max(nombres.length, telefonos.length);
  const contactos = [];
  for (let i = 0; i < cantidad; i++) {
    const nombre = (nombres[i] || '').trim();
    const telefono = (telefonos[i] || '').trim();
    if (nombre || telefono) contactos.push({ nombre: nombre || null, telefono: telefono || null });
  }
  return contactos;
}

async function guardarContactos(prospectoId, contactos) {
  // Reemplaza todos los contactos del prospecto — más simple que calcular
  // altas/bajas/cambios fila por fila, y acá no hace falta conservar ids.
  await pool.query('delete from prospectos_contactos where prospecto_id = $1', [prospectoId]);
  for (let i = 0; i < contactos.length; i++) {
    const c = contactos[i];
    await pool.query(
      'insert into prospectos_contactos (prospecto_id, nombre, telefono, orden) values ($1,$2,$3,$4)',
      [prospectoId, c.nombre, c.telefono, i]
    );
  }
}

async function traerContactos(prospectoId) {
  const { rows } = await pool.query(
    'select * from prospectos_contactos where prospecto_id = $1 order by orden, id',
    [prospectoId]
  );
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const prospectos = await listarConVisitas();
    // "YYYY-MM-DD" en hora de Argentina — así el filtro de fecha del
    // listado (que compara contra un <input type="date">, que manda el
    // mismo formato) puede comparar strings directo, sin líos de huso
    // horario cerca de la medianoche.
    prospectos.forEach((p) => { p.ultimaVisitaIso = p.ultima_visita ? hoyAr(p.ultima_visita) : null; });
    res.render('prospectos/lista', { prospectos });
  } catch (err) { next(err); }
});

router.get('/nuevo', async (req, res, next) => {
  try {
    res.render('prospectos/form', { prospecto: {}, contactos: [], error: null, accion: '/prospectos' });
  } catch (err) { next(err); }
});

// Submenú de "Visitas" para el celular: agrupa "Historial visitas" y
// "Nueva visita" bajo una sola cuadrícula de /menu (ver views/menu.ejs),
// en vez de ocupar dos lugares ahí — en la computadora esos dos siguen
// siendo dos links directos en la barra lateral, sin pasar por acá (ver
// partials/head.ejs). Va antes de "/:id" para que Express no confunda
// "menu" con un id de prospecto.
router.get('/menu', (req, res) => res.render('prospectos/menu'));

// El mapa vive acá adentro (no en una sección aparte): es otra forma de
// ver el mismo historial de visitas, con el mismo permiso de acceso.
router.get('/mapa', async (req, res, next) => {
  try {
    const prospectos = await listarConVisitas();
    res.render('prospectos/mapa', { prospectos });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { nombre, direccion, notas, cuit_dni } = req.body;
  const contactos = leerContactos(req.body);
  let lat = redondearCoord(req.body.lat);
  let lng = redondearCoord(req.body.lng);
  let ciudad = (req.body.ciudad || '').trim() || null;
  try {
    if (!nombre || !nombre.trim()) throw new Error('Falta el nombre del negocio.');
    if (!direccion || !direccion.trim()) throw new Error('Falta la dirección.');

    // Si el formulario no llegó con coordenadas (el JS del navegador no
    // pudo geocodificar, o el usuario no tocó "Buscar dirección"), se
    // intenta una vez más del lado del servidor antes de guardar sin
    // ubicación — así el prospecto casi nunca queda sin punto en el mapa.
    // De paso, si tampoco llegó la ciudad (el campo se completa solo al
    // elegir una opción en el buscador del navegador), se aprovecha este
    // mismo resultado para completarla.
    if (lat === null || lng === null) {
      const geo = await geocodificarDireccion(direccion);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
        if (!ciudad) ciudad = geo.ciudad || null;
      }
    }

    // Se intenta reconocer solo si el negocio ya está cargado como
    // cliente (por CUIT/DNI o teléfono coincidente) — ver lib/vinculacion.
    const clienteCoincidente = await buscarClienteCoincidente({
      nombre: nombre.trim(),
      cuitDni: cuit_dni,
      telefonos: contactos.map((c) => c.telefono),
    });

    const { rows } = await pool.query(
      `insert into prospectos (nombre, direccion, notas, lat, lng, cuit_dni, ciudad, cliente_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [nombre.trim(), direccion.trim(), notas || null, lat, lng, cuit_dni || null, ciudad, clienteCoincidente ? clienteCoincidente.id : null]
    );
    await guardarContactos(rows[0].id, contactos);
    // "recien_guardado=1" hace que, si el prospecto quedó sin vincular pero
    // hay algún cliente parecido (mismo nombre o domicilio), el aviso
    // aparezca como ventana emergente al llegar a esta página — no cada
    // vez que se la visite después (ver prospectos/detalle.ejs).
    res.redirect(`/prospectos/${rows[0].id}?recien_guardado=1`);
  } catch (err) {
    res.render('prospectos/form', {
      prospecto: { nombre, direccion, notas, lat, lng, ciudad, cuit_dni },
      contactos,
      error: err.message,
      accion: '/prospectos',
    });
  }
});

// Usado desde el formulario (JS) para buscar la dirección tipeada antes de
// guardar, sin recargar la página — devuelve JSON con varias opciones
// (una misma calle y altura puede existir en más de una provincia) para
// que la persona elija cuál es la correcta, en vez de asumir la primera.
// Va antes de las rutas "/:id..." para que Express no confunda la palabra
// "geocodificar" con un id de prospecto.
router.post('/geocodificar', async (req, res) => {
  const opciones = await buscarDirecciones(req.body.direccion, 5);
  if (opciones.length === 0) {
    return res.status(404).json({ error: 'No se encontró esa dirección. Marcá el punto a mano en el mapa.' });
  }
  res.json({ opciones });
});

// Editar y eliminar (tanto el prospecto como una visita ya cargada) queda
// solo para administradores — un vendedor puede registrar prospectos y
// visitas nuevas, pero no tocar lo que ya quedó guardado, para que el
// historial de visitas sea confiable. Los botones también se ocultan del
// lado de la vista (ver views/prospectos/detalle.ejs), esto es el
// resguardo real por si alguien entra directo a la URL.
router.get('/:id/editar', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from prospectos where id = $1', [req.params.id]);
    if (!rows[0]) return res.redirect('/prospectos');
    const contactos = await traerContactos(req.params.id);
    res.render('prospectos/form', { prospecto: rows[0], contactos, error: null, accion: `/prospectos/${rows[0].id}` });
  } catch (err) { next(err); }
});

router.post('/:id', requireAdmin, async (req, res, next) => {
  const { nombre, direccion, notas, cuit_dni } = req.body;
  const contactos = leerContactos(req.body);
  let lat = redondearCoord(req.body.lat);
  let lng = redondearCoord(req.body.lng);
  let ciudad = (req.body.ciudad || '').trim() || null;
  try {
    if (!nombre || !nombre.trim()) throw new Error('Falta el nombre del negocio.');
    if (!direccion || !direccion.trim()) throw new Error('Falta la dirección.');

    if (lat === null || lng === null) {
      const geo = await geocodificarDireccion(direccion);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
        if (!ciudad) ciudad = geo.ciudad || null;
      }
    }

    const { rows: actualRows } = await pool.query('select cliente_id from prospectos where id = $1', [req.params.id]);
    let clienteId = actualRows[0] ? actualRows[0].cliente_id : null;
    // No se pisa un vínculo que ya existe (manual o automático) — solo se
    // intenta reconocer de nuevo si todavía sigue sin vincular, por si
    // ahora sí hay coincidencia (p. ej. se acaba de completar el CUIT).
    if (!clienteId) {
      const clienteCoincidente = await buscarClienteCoincidente({
        nombre: nombre.trim(),
        cuitDni: cuit_dni,
        telefonos: contactos.map((c) => c.telefono),
      });
      if (clienteCoincidente) clienteId = clienteCoincidente.id;
    }

    await pool.query(
      `update prospectos set nombre=$1, direccion=$2, notas=$3, lat=$4, lng=$5, cuit_dni=$6, ciudad=$7, cliente_id=$8
       where id = $9`,
      [nombre.trim(), direccion.trim(), notas || null, lat, lng, cuit_dni || null, ciudad, clienteId, req.params.id]
    );
    await guardarContactos(req.params.id, contactos);
    // Al editar (a diferencia de al crear) ya suele haber visitas
    // registradas, así que conviene ir directo a esa sección en vez de
    // quedar arriba, en los datos del prospecto. "recien_guardado=1" es lo
    // mismo que al crear — dispara el cartel de posible vínculo como
    // ventana emergente, si corresponde (ver prospectos/detalle.ejs).
    res.redirect(`/prospectos/${req.params.id}?recien_guardado=1#historial-visitas`);
  } catch (err) {
    res.render('prospectos/form', {
      prospecto: { id: req.params.id, nombre, direccion, notas, lat, lng, ciudad, cuit_dni },
      contactos,
      error: err.message,
      accion: `/prospectos/${req.params.id}`,
    });
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select p.*, c.razon_social as cliente_nombre
       from prospectos p
       left join clientes c on c.id = p.cliente_id
       where p.id = $1`,
      [req.params.id]
    );
    const prospecto = rows[0];
    if (!prospecto) return res.redirect('/prospectos');

    const [{ rows: visitas }, contactos] = await Promise.all([
      pool.query('select * from prospectos_visitas where prospecto_id = $1 order by fecha desc, id desc', [prospecto.id]),
      traerContactos(prospecto.id),
    ]);

    // Si todavía no está vinculado a ningún cliente, se buscan
    // sugerencias (nombre parecido o mismo domicilio) para ofrecer un
    // click de "Vincular", y se trae la lista de clientes para el
    // buscador manual de respaldo.
    let sugerencias = [];
    let clientes = [];
    if (!prospecto.cliente_id) {
      [sugerencias, clientes] = await Promise.all([
        buscarSugerenciasCliente(prospecto),
        listarClientes(),
      ]);
    }

    res.render('prospectos/detalle', { prospecto, visitas, contactos, sugerencias, clientes, ahora: fechaHoraInput() });
  } catch (err) { next(err); }
});

router.post('/:id/vincular', async (req, res, next) => {
  try {
    const clienteId = req.body.cliente_id || null;
    if (clienteId) {
      await pool.query('update prospectos set cliente_id = $1 where id = $2', [clienteId, req.params.id]);
    }
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/desvincular', async (req, res, next) => {
  try {
    await pool.query('update prospectos set cliente_id = null where id = $1', [req.params.id]);
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/visitas', async (req, res, next) => {
  try {
    const { fecha, nota } = req.body;
    // Queda registrado quién la cargó — es lo que después decide quién la
    // puede borrar (ver /:id/visitas/:visitaId/eliminar más abajo).
    await pool.query(
      'insert into prospectos_visitas (prospecto_id, fecha, nota, usuario_id) values ($1, $2, $3, $4)',
      [req.params.id, inputAFecha(fecha) || new Date(), nota || null, req.session.usuario.id]
    );
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

// Eliminar una visita ya cargada: un administrador puede borrar cualquiera;
// un vendedor solo la que registró él mismo (nunca la editan, en ningún
// caso — eso sigue siendo solo de administradores, ver /:id/editar más
// abajo). El chequeo se hace acá, contra la base, no alcanza con ocultar
// el botón en la vista — por si alguien manda el pedido directo a la URL.
router.post('/:id/visitas/:visitaId/eliminar', async (req, res, next) => {
  try {
    const usuarioSesion = req.session.usuario;
    const { rows } = await pool.query(
      'select usuario_id from prospectos_visitas where id = $1 and prospecto_id = $2',
      [req.params.visitaId, req.params.id]
    );
    if (!rows[0]) return res.redirect(`/prospectos/${req.params.id}`); // ya no existe — nada que hacer
    const esDueño = rows[0].usuario_id !== null && String(rows[0].usuario_id) === String(usuarioSesion.id);
    if (!usuarioSesion.esAdmin && !esDueño) {
      return res.status(403).render('403', {
        motivo: 'Solo podés eliminar visitas que registraste vos mismo. Pedile a un administrador si hace falta borrar esta.',
      });
    }
    await pool.query('delete from prospectos_visitas where id = $1 and prospecto_id = $2', [req.params.visitaId, req.params.id]);
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/eliminar', requireAdmin, async (req, res, next) => {
  try {
    // No se borra de verdad — se marca inactivo, para no perder el
    // historial de visitas si se cargó por error o el prospecto ya no
    // interesa; simplemente deja de aparecer en el mapa y la lista.
    // También se suelta el vínculo con Clientes (si tenía uno): un
    // prospecto inactivo ya no se puede ver ni volver a vincular desde
    // ningún lado, así que dejarlo cargado solo podía terminar bloqueando
    // para siempre el borrado de ese cliente por una referencia que ya no
    // se usa ni se ve en ningún lado.
    await pool.query('update prospectos set activo = false, cliente_id = null where id = $1', [req.params.id]);
    res.redirect('/prospectos');
  } catch (err) { next(err); }
});

module.exports = router;
