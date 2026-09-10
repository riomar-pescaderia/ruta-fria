// Parsea texto pegado desde una planilla (Google Sheets pega separado por
// tabs; un CSV exportado viene separado por comas) en filas de objetos,
// usando la primera línea como encabezado.
//
// El mapeo de columnas es deliberadamente conservador: solo reconoce
// encabezados sin ambigüedad.
//
// "Flete", "IVA" e "IIBB" en la planilla de costos de Ruta Fría NO son
// porcentajes: son el monto ya calculado para ese artículo (o 0 si no
// aplica). Por eso no se cargan tal cual como flete_pct/aplica_iva/
// aplica_iibb — se usan solo para decidir, fila por fila:
//   - flete (monto)  -> si es distinto de 0, flete_pct queda en 6% fijo;
//                       si es 0, flete_pct queda en 0.
//   - iva (monto)     -> si es distinto de 0, aplica_iva queda activado;
//                       si es 0, se desactiva.
//   - iibb (monto)    -> igual que iva, para aplica_iibb.
// Esto se resuelve en routes/articulos.js (no acá), donde ya se sabe si el
// artículo es nuevo o existente.
const ALIAS = {
  codigo: ['codigo', 'código', 'cod', 'cod.'],
  nombre: ['nombre', 'producto', 'productos', 'item', 'ítem', 'articulo', 'artículo'],
  unidad: ['unidad', 'unid', 'unid.'],
  costo: ['costo', 'precio', 'precio bruto', 'pcio unit bruto', 'pcio. unit. bruto', 'precio unitario bruto'],
  margen_pct: ['margen', 'margen_pct', '%margen', '% margen', 'benef', '%benef', '% benef', 'beneficio', '%beneficio', '% beneficio'],
  flete_pct: ['flete_pct', 'flete (%)', 'flete%', 'flete_%'],
  flete_monto: ['flete'],
  iva_monto: ['iva'],
  iibb_monto: ['iibb'],
};

function normalizar(s) {
  return String(s).trim().toLowerCase();
}

function mapearEncabezado(encabezados) {
  return encabezados.map((h) => {
    const norm = normalizar(h);
    for (const [campo, alias] of Object.entries(ALIAS)) {
      if (alias.includes(norm)) return campo;
    }
    return null; // columna no reconocida — se ignora
  });
}

function parseTabla(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length < 2) return { filas: [], columnasReconocidas: [] };

  const delimitador = lineas[0].includes('\t') ? '\t' : ',';
  const partirLinea = (l) => l.split(delimitador).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));

  const encabezados = partirLinea(lineas[0]);
  const campos = mapearEncabezado(encabezados);

  const filas = lineas.slice(1).map((linea) => {
    const celdas = partirLinea(linea);
    const fila = {};
    campos.forEach((campo, i) => {
      if (campo) fila[campo] = celdas[i];
    });
    return fila;
  });

  return { filas, columnasReconocidas: campos.filter(Boolean) };
}

module.exports = { parseTabla };
