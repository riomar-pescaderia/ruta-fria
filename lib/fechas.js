// Fecha y hora del negocio — helpers centralizados para que cada
// transacción (venta, compra, presupuesto, visita, recibo, ajuste de
// cuenta corriente) quede registrada con el día Y LA HORA en que
// realmente se cargó, sin depender de en qué huso horario esté
// corriendo el servidor (Render corre en UTC, no en la hora de
// Argentina). La zona es fija porque Argentina no tiene horario de
// verano — no hace falta resolver ningún corrimiento estacional.
const ZONA = 'America/Argentina/Buenos_Aires';

function partesEnZona(fecha) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fecha);
  const obj = {};
  partes.forEach((p) => { obj[p.type] = p.value; });
  return obj;
}

// "YYYY-MM-DD" — solo el día, en hora de Argentina. Para donde no hace
// falta la hora (por ejemplo los rangos de fecha de los filtros del
// Panel de Informes), o como valor por defecto de un campo que todavía
// es de solo fecha.
function hoyAr(fecha = new Date()) {
  const p = partesEnZona(fecha);
  return `${p.year}-${p.month}-${p.day}`;
}

// "YYYY-MM-DDTHH:mm" — el formato que espera (y devuelve) un
// <input type="datetime-local">. Sirve tanto para el valor inicial
// ("ahora, en Argentina") como para reabrir un formulario con una fecha
// ya guardada (recibe lo que vuelve de Postgres: un Date de JS).
function fechaHoraInput(fecha = new Date()) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const p = partesEnZona(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Convierte lo que llega de un <input type="datetime-local"> —
// "YYYY-MM-DDTHH:mm", hora de pared en Argentina, sin zona — a un
// instante concreto para guardar en una columna timestamptz. Le pega el
// offset fijo "-03:00" en vez de dejar que Postgres lo interprete con
// el huso horario que tenga configurada la sesión: así el dato no se
// corre de hora (ni de día, cerca de la medianoche) al guardarlo, más
// allá de en qué huso ande corriendo el server en ese momento.
function inputAFecha(valor) {
  if (!valor) return null;
  const conMinutos = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor) ? `${valor}:00` : valor;
  return `${conMinutos}-03:00`;
}

// "DD/MM/YYYY HH:mm" — para mostrar una fecha con su hora en las
// pantallas de listado y detalle, siempre en hora de Argentina más allá
// de dónde esté físicamente el servidor o quien esté mirando la
// pantalla.
function formatearFechaHora(fecha) {
  if (!fecha) return '';
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const p = partesEnZona(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// "DD/MM/YYYY" — misma idea, sin la hora, para donde alcanza con el día.
function formatearFecha(fecha) {
  if (!fecha) return '';
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const p = partesEnZona(d);
  return `${p.day}/${p.month}/${p.year}`;
}

module.exports = { ZONA, hoyAr, fechaHoraInput, inputAFecha, formatearFechaHora, formatearFecha };
