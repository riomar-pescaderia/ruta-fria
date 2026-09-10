// Interpreta números tal como vienen de una planilla, aceptando tanto
// el formato argentino (punto de miles, coma decimal: "8.500,50")
// como un número simple sin separadores ("8500" o "8500.5").
function parseNumeroAr(valor) {
  if (valor === undefined || valor === null) return null;
  let s = String(valor).trim().replace(/\$/g, '').replace(/%/g, '').replace(/\s/g, '');
  if (s === '') return null;

  const tieneComa = s.includes(',');
  const tienePunto = s.includes('.');

  if (tieneComa && tienePunto) {
    // formato AR: 8.500,50 -> 8500.50
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (tieneComa && !tienePunto) {
    // 8500,50 -> 8500.50
    s = s.replace(',', '.');
  } else if (!tieneComa && tienePunto) {
    // ambiguo: "8.500" (miles) vs "8.5" (decimal).
    // si el único punto tiene exactamente 3 dígitos después, se asume separador de miles.
    const partes = s.split('.');
    if (partes.length === 2 && partes[1].length === 3) {
      s = partes.join('');
    }
    // si no, se deja como número decimal tal cual (ej. "8.5")
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseNumeroAr };
