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

// Coincidencias débiles (solo nombre normalizado igual) para un prospecto
// todavía sin vincular — se muestran como sugerencia en su detalle, para
// confirmar con un click en vez de vincular solo.
async function buscarSugerenciasCliente(prospecto) {
  const nombre = normalizarTexto(prospecto.nombre);
  if (!nombre) return [];
  const { rows: clientes } = await pool.query('select id, razon_social, cuit_dni from clientes');
  return clientes.filter((c) => normalizarTexto(c.razon_social) === nombre);
}

module.exports = {
  normalizarTexto,
  normalizarTelefono,
  normalizarCuit,
  buscarClienteCoincidente,
  vincularProspectosDeCliente,
  buscarSugerenciasCliente,
};
