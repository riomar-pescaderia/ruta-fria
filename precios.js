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

function calcularPrecios(articulo, config) {
  const costo = Number(articulo.costo) || 0;
  const ivaPct = articulo.aplica_iva ? Number(config.iva_pct) : 0;
  const iibbPct = articulo.aplica_iibb ? Number(config.iibb_pct) : 0;
  const fletePct = Number(articulo.flete_pct) || 0;
  const margenPct = Number(articulo.margen_pct) || 0;
  const recargoListaPct = Number(config.recargo_lista_pct) || 0;

  const costoConCargos = costo * (1 + (ivaPct + iibbPct + fletePct) / 100);
  const precioEfectivoSinRedondear = costoConCargos * (1 + margenPct / 100);
  const precioEfectivo = redondearA100(precioEfectivoSinRedondear);
  const precioLista = Math.round(precioEfectivo * (1 + recargoListaPct / 100));

  return {
    costoConCargos: round2(costoConCargos),
    precioEfectivo,
    precioLista,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function redondearA100(n) {
  return Math.round(n / 100) * 100;
}

module.exports = { calcularPrecios };
