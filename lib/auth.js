// Login con usuario y contraseña, más permisos por módulo (Clientes,
// Artículos, Compras, Gastos, Ventas) y un rol de administrador que da
// acceso a todo, incluida la gestión de usuarios. Las contraseñas se
// guardan siempre como hash (bcrypt), nunca en texto plano.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const MODULOS = ['clientes', 'articulos', 'compras', 'gastos', 'ventas'];

function columnaAcceso(modulo) {
  return `acceso_${modulo}`;
}

async function contarUsuarios() {
  const { rows } = await pool.query('select count(*)::int as n from usuarios');
  return rows[0].n;
}

// Cuenta administradores activos, opcionalmente excluyendo un id — sirve
// para no permitir dejar el sistema sin ningún administrador.
async function contarAdminsActivos(excluirId) {
  const { rows } = await pool.query(
    'select count(*)::int as n from usuarios where es_admin = true and activo = true and id <> coalesce($1, -1)',
    [excluirId || null]
  );
  return rows[0].n;
}

async function buscarPorUsername(username) {
  const { rows } = await pool.query(
    'select * from usuarios where username = $1 and activo = true',
    [username]
  );
  return rows[0] || null;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('select * from usuarios where id = $1', [id]);
  return rows[0] || null;
}

// Arma el objeto liviano que se guarda en la sesión y se usa en las
// vistas (nunca el hash de la contraseña).
function datosSesion(u) {
  return {
    id: u.id,
    username: u.username,
    nombre: u.nombre,
    esAdmin: u.es_admin,
    accesos: {
      clientes: u.acceso_clientes,
      articulos: u.acceso_articulos,
      compras: u.acceso_compras,
      gastos: u.acceso_gastos,
      ventas: u.acceso_ventas,
    },
  };
}

async function crearUsuario({ username, password, nombre, esAdmin, accesos }) {
  const hash = await bcrypt.hash(password, 10);
  const a = accesos || {};
  const { rows } = await pool.query(
    `insert into usuarios
      (username, password_hash, nombre, es_admin, acceso_clientes, acceso_articulos, acceso_compras, acceso_gastos, acceso_ventas)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      String(username).trim(),
      hash,
      nombre ? String(nombre).trim() : null,
      !!esAdmin,
      !!a.clientes,
      !!a.articulos,
      !!a.compras,
      !!a.gastos,
      !!a.ventas,
    ]
  );
  return rows[0];
}

async function cambiarPassword(id, password) {
  const hash = await bcrypt.hash(password, 10);
  await pool.query('update usuarios set password_hash = $1 where id = $2', [hash, id]);
}

// Actualiza el rol y los accesos por módulo de un usuario existente.
// Devuelve { ok: false, error } si la operación dejaría al sistema sin
// ningún administrador activo, en vez de aplicar el cambio.
async function actualizarPermisos(id, { esAdmin, accesos }) {
  const usuario = await buscarPorId(id);
  if (!usuario) return { ok: false, error: 'No encontré ese usuario.' };

  const quedaSinAdmin = usuario.es_admin && !esAdmin && (await contarAdminsActivos(id)) === 0;
  if (quedaSinAdmin) {
    return { ok: false, error: 'No podés sacarle el rol de administrador: quedaría el sistema sin ningún administrador.' };
  }

  const a = accesos || {};
  await pool.query(
    `update usuarios set es_admin=$1, acceso_clientes=$2, acceso_articulos=$3, acceso_compras=$4, acceso_gastos=$5, acceso_ventas=$6
     where id = $7`,
    [!!esAdmin, !!a.clientes, !!a.articulos, !!a.compras, !!a.gastos, !!a.ventas, id]
  );
  return { ok: true };
}

// Activa/desactiva un usuario, salvo que sea el último administrador
// activo (para no bloquear el acceso de todos por accidente).
async function alternarEstado(id) {
  const usuario = await buscarPorId(id);
  if (!usuario) return { ok: false, error: 'No encontré ese usuario.' };

  if (usuario.activo && usuario.es_admin && (await contarAdminsActivos(id)) === 0) {
    return { ok: false, error: 'No podés desactivar al último administrador activo.' };
  }

  await pool.query('update usuarios set activo = not activo where id = $1', [id]);
  return { ok: true };
}

async function verificarPassword(usuario, password) {
  return bcrypt.compare(String(password || ''), usuario.password_hash);
}

// Protege todas las rutas que se registren después de este middleware.
// Si no hay ningún usuario creado todavía, manda al asistente de
// configuración inicial en vez de a una pantalla de login sin salida.
async function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  try {
    const n = await contarUsuarios();
    if (n === 0) return res.redirect('/setup');
  } catch (err) {
    console.error('[ruta-fria] error chequeando usuarios:', err.message);
  }
  return res.redirect('/login');
}

// Se monta después de requireAuth: vuelve a leer el usuario de la base en
// cada pedido, para que un cambio de permisos hecho por un administrador
// tenga efecto al toque, sin que el usuario afectado tenga que volver a
// loguearse. También cierra la sesión sola si lo desactivaron.
async function refrescarSesion(req, res, next) {
  if (!req.session || !req.session.usuario) return next();
  try {
    const u = await buscarPorId(req.session.usuario.id);
    if (!u || !u.activo) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    req.session.usuario = datosSesion(u);
  } catch (err) {
    console.error('[ruta-fria] error actualizando la sesión:', err.message);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.usuario && req.session.usuario.esAdmin) return next();
  res.status(403).render('403', {
    motivo: 'Esta sección es solo para administradores.',
  });
}

function requireAcceso(modulo) {
  return (req, res, next) => {
    const u = req.session.usuario;
    if (u && (u.esAdmin || (u.accesos && u.accesos[modulo]))) return next();
    res.status(403).render('403', {
      motivo: 'No tenés acceso a esta sección. Pedile a un administrador que te lo habilite desde Usuarios.',
    });
  };
}

module.exports = {
  MODULOS,
  columnaAcceso,
  contarUsuarios,
  contarAdminsActivos,
  buscarPorUsername,
  buscarPorId,
  datosSesion,
  crearUsuario,
  cambiarPassword,
  actualizarPermisos,
  alternarEstado,
  verificarPassword,
  requireAuth,
  refrescarSesion,
  requireAdmin,
  requireAcceso,
};
