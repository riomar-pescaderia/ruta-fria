// Login con usuario y contraseña, más permisos por módulo (Clientes,
// Artículos, Compras, Gastos, Ventas) y un rol de administrador que da
// acceso a todo, incluida la gestión de usuarios. Las contraseñas se
// guardan siempre como hash (bcrypt) para validar el login, nunca en
// texto plano. Además se guarda una copia cifrada de forma reversible
// (no el hash) para que un administrador la pueda ver desde Usuarios;
// ver encryptPassword/decryptPassword más abajo.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');

const MODULOS = ['clientes', 'articulos', 'prospectos', 'mapa', 'ventas', 'cuenta_corriente', 'compras', 'gastos', 'stock'];

// Clave de cifrado derivada del mismo secreto que ya usa la sesión — así
// no hace falta pedir una variable de entorno nueva. Se deriva una vez
// (scryptSync es relativamente lento) y se reutiliza.
const CLAVE_CIFRADO = crypto.scryptSync(
  process.env.SESSION_SECRET || 'ruta-fria-cambiar-este-secreto',
  'ruta-fria-password-visible',
  32
);

// Cifra la contraseña en texto plano de forma reversible (AES-256-GCM),
// para que se pueda mostrar de nuevo más adelante. Devuelve un string
// que junta iv + tag + contenido cifrado, todo en base64.
function encryptPassword(plano) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CLAVE_CIFRADO, iv);
  const cifrado = Buffer.concat([cipher.update(String(plano), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, cifrado]).toString('base64');
}

// Revierte encryptPassword. Devuelve null si el valor es vacío o no se
// puede descifrar (por ejemplo, si cambió el secreto de la sesión).
function decryptPassword(valor) {
  if (!valor) return null;
  try {
    const datos = Buffer.from(valor, 'base64');
    const iv = datos.subarray(0, 12);
    const tag = datos.subarray(12, 28);
    const cifrado = datos.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', CLAVE_CIFRADO, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

// Permisos especiales: a diferencia de los accesos por módulo, no abren
// toda una sección sino una acción puntual y más delicada dentro de un
// módulo al que el usuario ya puede entrar. Por defecto son solo para
// administradores, pero — igual que los accesos por módulo — cualquier
// administrador se los puede delegar a otro usuario desde Usuarios.
const PERMISOS_ESPECIALES = ['editar_confirmadas'];

function columnaAcceso(modulo) {
  return `acceso_${modulo}`;
}

function columnaPermiso(permiso) {
  return `permiso_${permiso}`;
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

// El usuario no distingue mayúsculas de minúsculas: "Juan" y "juan" son
// la misma cuenta, tanto para loguearse como para crear una nueva.
async function buscarPorUsername(username) {
  const { rows } = await pool.query(
    'select * from usuarios where lower(username) = lower($1) and activo = true',
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
      prospectos: u.acceso_prospectos,
      mapa: u.acceso_mapa,
      stock: u.acceso_stock,
      cuenta_corriente: u.acceso_cuenta_corriente,
    },
    permisos: {
      editarConfirmadas: u.permiso_editar_confirmadas,
    },
  };
}

async function crearUsuario({ username, password, nombre, esAdmin, accesos, permisos }) {
  const hash = await bcrypt.hash(password, 10);
  const visible = encryptPassword(password);
  const a = accesos || {};
  const p = permisos || {};
  const { rows } = await pool.query(
    `insert into usuarios
      (username, password_hash, password_visible, nombre, es_admin, acceso_clientes, acceso_articulos, acceso_compras, acceso_gastos, acceso_ventas, acceso_prospectos, acceso_stock, acceso_cuenta_corriente, permiso_editar_confirmadas, acceso_mapa)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [
      String(username).trim(),
      hash,
      visible,
      nombre ? String(nombre).trim() : null,
      !!esAdmin,
      !!a.clientes,
      !!a.articulos,
      !!a.compras,
      !!a.gastos,
      !!a.ventas,
      !!a.prospectos,
      !!a.stock,
      !!a.cuenta_corriente,
      !!p.editarConfirmadas,
      !!a.mapa,
    ]
  );
  return rows[0];
}

async function cambiarPassword(id, password) {
  const hash = await bcrypt.hash(password, 10);
  const visible = encryptPassword(password);
  await pool.query('update usuarios set password_hash = $1, password_visible = $2 where id = $3', [hash, visible, id]);
}

// Actualiza el rol y los accesos por módulo de un usuario existente.
// Devuelve { ok: false, error } si la operación dejaría al sistema sin
// ningún administrador activo, en vez de aplicar el cambio.
async function actualizarPermisos(id, { esAdmin, accesos, permisos }) {
  const usuario = await buscarPorId(id);
  if (!usuario) return { ok: false, error: 'No encontré ese usuario.' };

  const quedaSinAdmin = usuario.es_admin && !esAdmin && (await contarAdminsActivos(id)) === 0;
  if (quedaSinAdmin) {
    return { ok: false, error: 'No podés sacarle el rol de administrador: quedaría el sistema sin ningún administrador.' };
  }

  const a = accesos || {};
  const p = permisos || {};
  await pool.query(
    `update usuarios set es_admin=$1, acceso_clientes=$2, acceso_articulos=$3, acceso_compras=$4, acceso_gastos=$5, acceso_ventas=$6, acceso_prospectos=$7, acceso_stock=$8, acceso_cuenta_corriente=$9, permiso_editar_confirmadas=$10, acceso_mapa=$11
     where id = $12`,
    [!!esAdmin, !!a.clientes, !!a.articulos, !!a.compras, !!a.gastos, !!a.ventas, !!a.prospectos, !!a.stock, !!a.cuenta_corriente, !!p.editarConfirmadas, !!a.mapa, id]
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

// Un administrador siempre puede; cualquier otro usuario necesita que le
// hayan delegado este permiso especial desde Usuarios.
function puedeEditarConfirmadas(usuarioSesion) {
  return !!(usuarioSesion && (usuarioSesion.esAdmin || (usuarioSesion.permisos && usuarioSesion.permisos.editarConfirmadas)));
}

module.exports = {
  MODULOS,
  PERMISOS_ESPECIALES,
  columnaAcceso,
  columnaPermiso,
  puedeEditarConfirmadas,
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
  decryptPassword,
  requireAuth,
  refrescarSesion,
  requireAdmin,
  requireAcceso,
};
