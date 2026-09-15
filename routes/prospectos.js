// Historial de visitas a potenciales clientes (prospectos) — separado de
// Clientes a propósito: acá se cargan direcciones de gente que todavía no
// compró, para planificar y llevar registro de las visitas que se les
// hacen, con un mapa que muestra cada punto y cuántas veces se visitó.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { geocodificarDireccion, buscarDirecciones } = require('../lib/geocode');

function redondearCoord(n) {
  return n === null || n === undefined || n === '' ? null : Number(n);
}

// Trae todos los prospectos activos con la cantidad de visitas, la fecha
// de la última y el nombre del cliente vinculado (si ya lo es), para la
// lista y el mapa principal.
async function listarConVisitas() {
  const { rows } = await pool.query(`
    select p.*,
           count(v.id)::int as cantidad_visitas,
           max(v.fecha) as ultima_visita,
           c.razon_social as cliente_nombre
    from prospectos p
    left join prospectos_visitas v on v.prospecto_id = p.id
    left join clientes c on c.id = p.cliente_id
    where p.activo = true
    group by p.id, c.razon_social
    order by p.nombre
  `);
  return rows;
}

async function listarClientes() {
  const { rows } = await pool.query('select id, razon_social, cuit_dni from clientes order by razon_social');
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const prospectos = await listarConVisitas();
    res.render('prospectos/mapa', { prospectos });
  } catch (err) { next(err); }
});

router.get('/nuevo', async (req, res, next) => {
  try {
    const clientes = await listarClientes();
    res.render('prospectos/form', { prospecto: {}, clientes, error: null, accion: '/prospectos' });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { nombre, contacto, telefono, direccion, notas } = req.body;
  const cliente_id = req.body.cliente_id || null;
  let lat = redondearCoord(req.body.lat);
  let lng = redondearCoord(req.body.lng);
  try {
    if (!nombre || !nombre.trim()) throw new Error('Falta el nombre.');
    if (!direccion || !direccion.trim()) throw new Error('Falta la dirección.');

    // Si el formulario no llegó con coordenadas (el JS del navegador no
    // pudo geocodificar, o el usuario no tocó "Buscar dirección"), se
    // intenta una vez más del lado del servidor antes de guardar sin
    // ubicación — así el prospecto casi nunca queda sin punto en el mapa.
    if (lat === null || lng === null) {
      const geo = await geocodificarDireccion(direccion);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }

    const { rows } = await pool.query(
      `insert into prospectos (nombre, contacto, telefono, direccion, notas, lat, lng, cliente_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [nombre.trim(), contacto || null, telefono || null, direccion.trim(), notas || null, lat, lng, cliente_id]
    );
    res.redirect(`/prospectos/${rows[0].id}`);
  } catch (err) {
    const clientes = await listarClientes().catch(() => []);
    res.render('prospectos/form', {
      prospecto: { nombre, contacto, telefono, direccion, notas, lat, lng, cliente_id },
      clientes,
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

router.get('/:id/editar', async (req, res, next) => {
  try {
    const [{ rows }, clientes] = await Promise.all([
      pool.query('select * from prospectos where id = $1', [req.params.id]),
      listarClientes(),
    ]);
    if (!rows[0]) return res.redirect('/prospectos');
    res.render('prospectos/form', { prospecto: rows[0], clientes, error: null, accion: `/prospectos/${rows[0].id}` });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  const { nombre, contacto, telefono, direccion, notas } = req.body;
  const cliente_id = req.body.cliente_id || null;
  let lat = redondearCoord(req.body.lat);
  let lng = redondearCoord(req.body.lng);
  try {
    if (!nombre || !nombre.trim()) throw new Error('Falta el nombre.');
    if (!direccion || !direccion.trim()) throw new Error('Falta la dirección.');

    if (lat === null || lng === null) {
      const geo = await geocodificarDireccion(direccion);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }

    await pool.query(
      `update prospectos set nombre=$1, contacto=$2, telefono=$3, direccion=$4, notas=$5, lat=$6, lng=$7, cliente_id=$8
       where id = $9`,
      [nombre.trim(), contacto || null, telefono || null, direccion.trim(), notas || null, lat, lng, cliente_id, req.params.id]
    );
    // Al editar (a diferencia de al crear) ya suele haber visitas
    // registradas, así que conviene ir directo a esa sección en vez de
    // quedar arriba, en los datos del prospecto.
    res.redirect(`/prospectos/${req.params.id}#historial-visitas`);
  } catch (err) {
    const clientes = await listarClientes().catch(() => []);
    res.render('prospectos/form', {
      prospecto: { id: req.params.id, nombre, contacto, telefono, direccion, notas, lat, lng, cliente_id },
      clientes,
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

    const { rows: visitas } = await pool.query(
      'select * from prospectos_visitas where prospecto_id = $1 order by fecha desc, id desc',
      [prospecto.id]
    );
    res.render('prospectos/detalle', { prospecto, visitas });
  } catch (err) { next(err); }
});

router.post('/:id/visitas', async (req, res, next) => {
  try {
    const { fecha, nota } = req.body;
    await pool.query(
      'insert into prospectos_visitas (prospecto_id, fecha, nota) values ($1, $2, $3)',
      [req.params.id, fecha || new Date().toISOString().slice(0, 10), nota || null]
    );
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/visitas/:visitaId/eliminar', async (req, res, next) => {
  try {
    await pool.query('delete from prospectos_visitas where id = $1 and prospecto_id = $2', [req.params.visitaId, req.params.id]);
    res.redirect(`/prospectos/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    // No se borra de verdad — se marca inactivo, para no perder el
    // historial de visitas si se cargó por error o el prospecto ya no
    // interesa; simplemente deja de aparecer en el mapa y la lista.
    await pool.query('update prospectos set activo = false where id = $1', [req.params.id]);
    res.redirect('/prospectos');
  } catch (err) { next(err); }
});

module.exports = router;
