// Límite de intentos de login, para frenar la fuerza bruta contra /login
// (web) y /api/app/login (la app del celular) — antes no existía ningún
// freno, así que se podían probar contraseñas en bucle sin que el
// sistema hiciera nada. Se cuenta por IP (server.js ya tiene
// "trust proxy" configurado para que req.ip sea la IP real del que pide,
// no la de Render) y por separado para la web y la app, para que un
// bloqueo de una no afecte a la otra.
//
// El conteo vive en memoria, no en la base de datos — no hace falta más
// que eso porque el servicio corre en una sola instancia (plan free de
// Render). Si el servicio se reinicia el conteo se resetea solo, lo cual
// está bien: no tiene sentido mantener un bloqueo entre reinicios.

const MAX_INTENTOS = 6; // intentos fallidos seguidos permitidos
const VENTANA_MS = 15 * 60 * 1000; // ventana en la que se cuentan esos intentos
const BLOQUEO_MS = 15 * 60 * 1000; // cuánto dura el bloqueo al pasarse

// clave -> { intentos, desde, bloqueadoHasta }
const estado = new Map();

// Limpieza periódica para no acumular en memoria para siempre claves de
// IPs que probaron una vez y no volvieron más. No hace falta que sea muy
// seguido: es solo para no dejar crecer el Map sin límite.
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, datos] of estado) {
    const bloqueoVencido = !datos.bloqueadoHasta || datos.bloqueadoHasta < ahora;
    const ventanaVencida = ahora - datos.desde > VENTANA_MS;
    if (bloqueoVencido && ventanaVencida) estado.delete(clave);
  }
}, 10 * 60 * 1000).unref();

// Devuelve null si la clave puede intentar loguearse, o la cantidad de
// minutos que le faltan al bloqueo (redondeado para arriba, mínimo 1)
// si está bloqueada.
function estaBloqueado(clave) {
  const datos = estado.get(clave);
  if (!datos || !datos.bloqueadoHasta) return null;
  const restante = datos.bloqueadoHasta - Date.now();
  if (restante <= 0) return null;
  return Math.max(1, Math.ceil(restante / 60000));
}

// Se llama después de un intento de login que resultó con usuario o
// contraseña incorrectos. Si la ventana anterior ya venció, arranca de
// nuevo desde cero en vez de sumar sobre un conteo viejo.
function registrarFallo(clave) {
  const ahora = Date.now();
  let datos = estado.get(clave);
  if (!datos || ahora - datos.desde > VENTANA_MS) {
    datos = { intentos: 0, desde: ahora, bloqueadoHasta: null };
  }
  datos.intentos += 1;
  if (datos.intentos >= MAX_INTENTOS) {
    datos.bloqueadoHasta = ahora + BLOQUEO_MS;
  }
  estado.set(clave, datos);
}

// Se llama después de un login correcto — borra el conteo de esa clave,
// así un intento fallido de hace rato no se arrastra para siempre.
function registrarExito(clave) {
  estado.delete(clave);
}

module.exports = { estaBloqueado, registrarFallo, registrarExito };
