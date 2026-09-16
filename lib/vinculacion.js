// Vincula automáticamente un prospecto (Historial de visitas) con su
// cliente en Clientes, sin que haya que buscarlo y elegirlo a mano.
//
// Reglas: CUIT/DNI igual o teléfono igual (ambos normalizados) son
// coincidencias fuertes — suficientes para vincular solos, sin pedir
// confirmación, porque dos negocios distintos casi nunca comparten esos
// datos por accidente. El nombre igual (ya normalizado) es más débil —
// dos prospectos podrían llamarse parecido sin ser el mismo negocio — así
// que esa coincidencia solo se sugiere, y hace falta un click de
// confirmación desde el detalle del prospecto para vincularla.
const pool = require('../db/pool');

function normalizarTexto(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarTelefono(s) {
  if (!s) return '';
  const digitos = String(s).replace(/\D/g, '');
  // se comparan los últimos 8 dígitos: así "3624123456", "03624123456" y
  // "+543624123456" (mismo teléfono con o sin prefijo de país/área) dan
  // igual, en vez de exigir que esté cargado carácter por carácter igual.
  return digitos.length >= 8 ? digitos.slice(-8) : digitos;
}

function normalizarCuit(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

// Distancia en metros entre dos puntos (fórmula de Haversine) — se usa
// para reconocer el mismo domicilio aunque la dirección esté tipeada de
// forma distinta de un lado y del otro (con o sin "Av.", con otro orden,
// etc.): lo que importa es que el punto geocodificado caiga en el mismo
// lugar, no que el texto sea idéntico.
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Radio dentro del cual dos puntos geocodificados se consideran "el mismo
// domicilio" — suficiente para tolerar la imprecisión normal de geocodificar
// (que puede ubicar el punto en la esquina en vez de en la puerta exacta)
// sin llegar a confundir negocios vecinos distintos.
const RADIO_METROS_MISMO_DOMICILIO = 120;

// Compara el domicilio de dos registros (prospecto y/o cliente, ambos con
// {direccion, lat, lng}). Si los dos tienen coordenadas, se compara por
// distancia (más confiable: tolera direcciones tipeadas distinto). Si a
// alguno le falta la geocodificación, se cae a comparar el texto de la
// dirección ya normalizado, como último recurso.
function domicilioCoincide(a, b) {
  const latA = a.lat === null || a.lat === undefined ? null : Number(a.lat);
  const lngA = a.lng === null || a.lng === undefined ? null : Number(a.lng);
  const latB = b.lat === null || b.lat === undefined ? null : Number(b.lat);
  const lngB = b.lng === null || b.lng === undefined ? null : Number(b.lng);
  if (latA !== null && lngA !== null && latB !== null && lngB !== null) {
    return distanciaMetros(latA, lngA, latB, lngB) <= RADIO_METROS_MISMO_DOMICILIO;
  }
  const dirA = normalizarTexto(a.direccion);
  const dirB = normalizarTexto(b.direccion);
  return !!dirA && dirA === dirB;
}

async function traerTelefonosProspecto(prospectoId) {
  const { rows } = await pool.query('select telefono from prospectos_contactos where prospecto_id = $1', [prospectoId]);
  return rows.map((r) => r.telefono).filter(Boolean);
}

// Busca, entre TODOS los clientes cargados, uno que coincida fuerte (CUIT
// o teléfono) con los datos de un prospecto. Se usa al crear o editar un
// prospecto, para el caso de que el cliente ya estuviera cargado antes.
async function buscarClienteCoincidente({ nombre, cuitDni, telefonos }) {
  const cuit = normalizarCuit(cuitDni);
  const tels = (telefonos || []).map(normalizarTelefono).filter(Boolean);

  const { rows: clientes } = await pool.query('select id, razon_social, cuit_dni, telefono from clientes');
  for (const c of clientes) {
    const cCuit = normalizarCuit(c.cuit_dni);
    if (cuit && cCuit && cuit === cCuit) return c;
  }
  for (const c of clientes) {
    const cTel = normalizarTelefono(c.telefono);
    if (cTel && tels.includes(cTel)) return c;
  }
  return null;
}

// Busca, entre los prospectos todavía sin vincular, todos los que
// coincidan fuerte (CUIT o teléfono) con un cliente recién creado o
// editado, y los vincula. Se usa desde Clientes al guardar.
async function vincularProspectosDeCliente(clienteId) {
  const { rows: clienteRows } = await pool.query('select id, razon_social, cuit_dni, telefono from clientes where id = $1', [clienteId]);
  const cliente = clienteRows[0];
  if (!cliente) return [];

  const cuit = normalizarCuit(cliente.cuit_dni);
  const tel = normalizarTelefono(cliente.telefono);
  if (!cuit && !tel) return [];

  const { rows: prospectos } = await pool.query(
    'select id, nombre, cuit_dni from prospectos where activo = true and cliente_id is null'
  );

  const vinculados = [];
  for (const p of prospectos) {
    const pCuit = normalizarCuit(p.cuit_dni);
    let coincide = !!(cuit && pCuit && cuit === pCuit);
    if (!coincide && tel) {
      const tels = await traerTelefonosProspecto(p.id);
      coincide = tels.map(normalizarTelefono).includes(tel);
    }
    if (coincide) {
      await pool.query('update prospectos set cliente_id = $1 where id = $2', [clienteId, p.id]);
      vinculados.push(p);
    }
  }
  return vinculados;
}

// Coincidencias débiles (nombre normalizado igual, o mismo domicilio) para
// un prospecto todavía sin vincular — se muestran como sugerencia en su
// detalle, para confirmar con un click en vez de vincular solo. Cada
// sugerencia lleva el motivo (nombre y/o domicilio) para poder mostrar el
// cartel correcto — no siempre es por el nombre.
async function buscarSugerenciasCliente(prospecto) {
  const nombre = normalizarTexto(prospecto.nombre);
  const { rows: clientes } = await pool.query('select id, razon_social, cuit_dni, direccion, lat, lng from clientes');
  const sugerencias = [];
  for (const c of clientes) {
    const porNombre = !!nombre && normalizarTexto(c.razon_social) === nombre;
    const porDomicilio = domicilioCoincide(prospecto, c);
    if (porNombre || porDomicilio) sugerencias.push({ ...c, porNombre, porDomicilio });
  }
  return sugerencias;
}

// Misma idea, en la otra dirección: coincidencias por domicilio para un
// cliente recién cargado o editado, entre los prospectos todavía sin
// vincular — se ofrecen como un cartel al guardar el cliente (ver
// routes/clientes.js), en vez de vincular solo, porque compartir el mismo
// punto geográfico es un indicio fuerte pero no siempre certero (p. ej. dos
// locales distintos en la misma galería).
async function buscarProspectosPorDomicilio(cliente) {
  const { rows: prospectos } = await pool.query(
    'select id, nombre, direccion, lat, lng from prospectos where activo = true and cliente_id is null'
  );
  return prospectos.filter((p) => domicilioCoincide(p, cliente));
}

module.exports = {
  normalizarTexto,
  normalizarTelefono,
  normalizarCuit,
  domicilioCoincide,
  buscarClienteCoincidente,
  vincularProspectosDeCliente,
  buscarSugerenciasCliente,
  buscarProspectosPorDomicilio,
};
