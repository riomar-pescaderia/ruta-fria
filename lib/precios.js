// Calculadora de precio — Fase 1.
//
// costo -> + IVA (si aplica) + IIBB (si aplica) + flete -> costo con cargos
//       -> + margen de beneficio -> precio_efectivo (precio en efectivo / mayorista)
//       -> + recargo general por medio de pago -> precio_lista
//
// OJO: falta confirmar con un par de artículos reales de la planilla actual si el
// margen se aplica sobre el costo solo o sobre el costo ya con IVA/IIBB/flete sumados.
// Acá se asume esto último (margen sobre el costo con cargos) — es un solo número
// para cambiar (la línea de "costoConCargos" de abajo) el día que lo confirmemos.
//
// Redondeo: el precio en efectivo se redondea al múltiplo de 100 más cercano
// (así queda un número "de mostrador", sin centavos ni sueltos), y el precio
// de lista se calcula a partir de ESE precio en efectivo ya redondeado, y a
// su vez se redondea a un entero (sin decimales).
//
// Costo por kg vendido por unidad: hay artículos que se venden por unidad
// (un paquete, ej. "x 200g") pero cuyo costo llega de la factura del
// proveedor por kilogramo. Para esos casos, unidad='unidad' junto con
// contenido_gr (los gramos que trae cada unidad) — el costo cargado se
// interpreta como precio por kg y se divide entre las unidades que salen de
// ese kilo (equivalente a costo_kg × contenido_gr / 1000) antes de aplicar
// IVA/IIBB/flete/margen. Si contenido_gr no está cargado, el costo se usa
// tal cual (como si fuera ya el costo por unidad).

function calcularPrecios(articulo, config) {
  const costoPorUnidad = round2(costoBaseUnitario(articulo));
  const ivaPct = articulo.aplica_iva ? Number(config.iva_pct) : 0;
  const iibbPct = articulo.aplica_iibb ? Number(config.iibb_pct) : 0;
  const fletePct = Number(articulo.flete_pct) || 0;
  const margenPct = Number(articulo.margen_pct) || 0;
  const recargoListaPct = Number(config.recargo_lista_pct) || 0;

  const costoConCargos = costoPorUnidad * (1 + (ivaPct + iibbPct + fletePct) / 100);
  const precioEfectivoSinRedondear = costoConCargos * (1 + margenPct / 100);
  const precioEfectivo = redondearA100(precioEfectivoSinRedondear);
  const precioLista = Math.round(precioEfectivo * (1 + recargoListaPct / 100));

  return {
    costoPorUnidad,
    costoConCargos: round2(costoConCargos),
    precioEfectivo,
    precioLista,
  };
}

// Costo "por unidad de venta": si el artículo se vende por unidad y tiene
// cargado cuántos gramos trae cada una, el costo guardado (por kg) se
// convierte al costo real de esa unidad. Para todo lo demás (kg, cajón,
// bolsa, o "unidad" sin contenido_gr cargado) el costo se usa tal cual.
function costoBaseUnitario(articulo) {
  const costo = Number(articulo.costo) || 0;
  const contenidoGr = Number(articulo.contenido_gr) || 0;
  if (articulo.unidad === 'unidad' && contenidoGr > 0) {
    return costo * (contenidoGr / 1000);
  }
  return costo;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function redondearA100(n) {
  return Math.round(n / 100) * 100;
}

module.exports = { calcularPrecios };
