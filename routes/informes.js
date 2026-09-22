// Panel de Informes — panel de solo lectura con informes y resúmenes del
// negocio. Arranca con gastos (lo que ya se cargó en Compras con una
// categoría distinta de "mercadería", ver lib/categoriasGasto.js) y va a
// ir sumando lo que se necesite; no agrega una forma nueva de cargar
// gastos, que siguen entrando por "+ Nueva factura" en Compras. Por
// ahora informa y compara: total del período por categoría y subtipo,
// evolución mes a mes, y cómo se reparten los gastos y las ventas entre
// los días de la semana y las semanas del mes — para poder mirar el
// negocio desde varios ángulos a la hora de decidir.
//
// Ojo: "franja horaria" y "turno" todavía no se pueden filtrar acá. Desde
// que Ventas y Compras registran la hora de cada operación (ver
// lib/fechas.js), el dato existe para lo que se cargue de acá en
// adelante — pero no para lo viejo, que quedó a las 00:00 porque esa
// hora nunca se guardó. Este desglose se puede sumar más adelante, a
// medida que se acumulen operaciones con la hora real.
const express = require('express');
const pool = require('../db/pool');
const { CATEGORIAS_GASTO, categoriaPorClave } = require('../lib/categoriasGasto');
const { hoyAr } = require('../lib/fechas');

const router = express.Router();

// A los fines de estos informes, el costo de "mercadería" incluye
// también el flete para traerla ("flete_mercaderia") — mismo criterio
// que ya se usa para armar el precio de venta, donde el flete_pct de
// cada artículo se suma al costo antes del margen (ver
// lib/precios.js). Por eso "Gastos" (gasto operativo general, más
// abajo) excluye las dos categorías, y el costo/rentabilidad de
// mercadería de Ventas las suma a las dos.
const CONDICION_NO_MERCADERIA = `categoria not in ('mercaderia','flete_mercaderia')`;
const CONDICION_MERCADERIA = `categoria in ('mercaderia','flete_mercaderia')`;

const NOMBRES_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function aFechaISO(d) {
  return d.toLocaleDateString('en-CA');
}

function primerDiaMes(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  return aFechaISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

function sumarDias(fechaISO, dias) {
  const d = new Date(fechaISO + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return aFechaISO(d);
}

function primerDiaMesesAtras(fechaISO, meses) {
  const d = new Date(fechaISO + 'T00:00:00');
  return aFechaISO(new Date(d.getFullYear(), d.getMonth() - meses, 1));
}

function diasEntre(desdeISO, hastaISO) {
  const ms = new Date(hastaISO + 'T00:00:00') - new Date(desdeISO + 'T00:00:00');
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

// Valida categoría/subtipo contra la taxonomía compartida con Compras —
// mismo criterio que leerCategoria/leerSubtipo de routes/compras.js, para
// no dejar pasar un filtro con una clave inventada.
function leerFiltroCategoria(query) {
  const cat = CATEGORIAS_GASTO.find((c) => c.clave === query.categoria);
  if (!cat) return { categoria: '', subtipo: '' };
  const subtipo = cat.subtipos.includes(query.subtipo) ? query.subtipo : '';
  return { categoria: cat.clave, subtipo };
}

async function totalesGasto({ desde, hasta, categoria, subtipo }) {
  const cond = [CONDICION_NO_MERCADERIA, `fecha::date >= $1`, `fecha::date <= $2`];
  const params = [desde, hasta];
  if (categoria) { params.push(categoria); cond.push(`categoria = $${params.length}`); }
  if (subtipo) { params.push(subtipo); cond.push(`subtipo = $${params.length}`); }
  const { rows } = await pool.query(
    `select coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
     from facturas_compra where ${cond.join(' and ')}`,
    params
  );
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad };
}

async function totalesVenta({ desde, hasta }) {
  const { rows } = await pool.query(
    `select coalesce(sum(v.total),0)::numeric as total, count(distinct v.id)::int as cantidad,
            coalesce(sum(vi.cantidad),0)::numeric as unidades
     from ventas v
     left join (select venta_id, sum(cantidad) as cantidad from ventas_items group by venta_id) vi on vi.venta_id = v.id
     where v.fecha::date >= $1 and v.fecha::date <= $2`,
    [desde, hasta]
  );
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad, unidades: Number(rows[0].unidades) };
}

// Variación porcentual entre el período elegido y el período anterior
// equivalente (misma cantidad de días, inmediatamente antes) — null si no
// hay con qué comparar (período anterior en cero), para no mostrar un
// "+infinito" sin sentido.
function variacion(actual, anterior) {
  if (!anterior) return null;
  return ((actual - anterior) / anterior) * 100;
}

// Función compartida para armar los rangos rápidos de fecha (este mes,
// mes pasado, últimos 30 días, este año) que aparecen arriba del filtro
// tanto en Gastos como en Ventas.
function armarRangosRapidos(hoy) {
  const anioActual = hoy.slice(0, 4);
  const mesPasadoDesde = primerDiaMesesAtras(hoy, 1);
  return [
    { etiqueta: 'Este mes', desde: primerDiaMes(hoy), hasta: hoy },
    { etiqueta: 'Mes pasado', desde: mesPasadoDesde, hasta: sumarDias(primerDiaMes(hoy), -1) },
    { etiqueta: 'Últimos 30 días', desde: sumarDias(hoy, -29), hasta: hoy },
    { etiqueta: 'Este año', desde: `${anioActual}-01-01`, hasta: hoy },
  ];
}

// Landing del Panel de Informes: de acá se entra a cada sub-sección
// (por ahora Gastos y Ventas) — pensado para ir agregando más
// secciones como tarjetas nuevas, sin tocar las que ya existen.
router.get('/', (req, res) => {
  res.render('informes/index');
});

router.get('/gastos', async (req, res, next) => {
  try {
    const hoy = hoyAr();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : primerDiaMes(hoy);
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : hoy;
    const { categoria, subtipo } = leerFiltroCategoria(req.query);

    const dias = diasEntre(desde, hasta);
    const desdeAnt = sumarDias(desde, -dias);
    const hastaAnt = sumarDias(desde, -1);

    const filtro = { desde, hasta, categoria, subtipo };
    const filtroAnt = { desde: desdeAnt, hasta: hastaAnt, categoria, subtipo };

    // Este informe es solo de gastos (las ventas ya tienen su propio
    // informe en /informes/ventas — no hace falta repetirlas acá).
    const [gastoActual, gastoAnterior] = await Promise.all([
      totalesGasto(filtro),
      totalesGasto(filtroAnt),
    ]);

    const resumen = {
      gasto: { ...gastoActual, variacion: variacion(gastoActual.total, gastoAnterior.total) },
      promedioPorFactura: gastoActual.cantidad ? gastoActual.total / gastoActual.cantidad : 0,
    };

    // Gastos por categoría, con el detalle de subtipo anidado y el % que
    // representa cada una sobre el total del período — respeta los mismos
    // filtros que el resumen (si ya se filtró por categoría, esta tabla
    // queda mostrando solo sus subtipos).
    const condCat = [CONDICION_NO_MERCADERIA, `fecha::date >= $1`, `fecha::date <= $2`];
    const paramsCat = [desde, hasta];
    if (categoria) { paramsCat.push(categoria); condCat.push(`categoria = $${paramsCat.length}`); }
    if (subtipo) { paramsCat.push(subtipo); condCat.push(`subtipo = $${paramsCat.length}`); }
    const { rows: filasCategoria } = await pool.query(
      `select categoria, subtipo, coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
       from facturas_compra where ${condCat.join(' and ')}
       group by categoria, subtipo`,
      paramsCat
    );
    const porCategoriaMap = new Map();
    for (const fila of filasCategoria) {
      const info = categoriaPorClave(fila.categoria);
      if (!porCategoriaMap.has(fila.categoria)) {
        porCategoriaMap.set(fila.categoria, {
          clave: fila.categoria,
          etiqueta: info ? info.etiqueta : fila.categoria,
          total: 0,
          cantidad: 0,
          subtipos: [],
        });
      }
      const entrada = porCategoriaMap.get(fila.categoria);
      entrada.total += Number(fila.total);
      entrada.cantidad += fila.cantidad;
      if (fila.subtipo) {
        entrada.subtipos.push({ nombre: fila.subtipo, total: Number(fila.total), cantidad: fila.cantidad });
      }
    }
    const porCategoria = [...porCategoriaMap.values()].sort((a, b) => b.total - a.total);
    porCategoria.forEach((c) => {
      c.subtipos.sort((a, b) => b.total - a.total);
      c.pct = resumen.gasto.total ? (c.total / resumen.gasto.total) * 100 : 0;
    });
    const categoriaTop = porCategoria[0] || null;
    const maxCategoria = categoriaTop ? categoriaTop.total : 0;

    // Comparativa por categoría: período elegido contra el período
    // anterior equivalente — para responder "¿en qué gasté más o menos
    // que la vez pasada?" de un vistazo. Ordenado por mayor diferencia en
    // PESOS primero (no en %), para que una categoría chica que se
    // duplicó no tape a una grande que subió bastante más en plata.
    const condCatAnt = [CONDICION_NO_MERCADERIA, `fecha::date >= $1`, `fecha::date <= $2`];
    const paramsCatAnt = [desdeAnt, hastaAnt];
    if (categoria) { paramsCatAnt.push(categoria); condCatAnt.push(`categoria = $${paramsCatAnt.length}`); }
    if (subtipo) { paramsCatAnt.push(subtipo); condCatAnt.push(`subtipo = $${paramsCatAnt.length}`); }
    const { rows: filasCategoriaAnt } = await pool.query(
      `select categoria, coalesce(sum(total),0)::numeric as total
       from facturas_compra where ${condCatAnt.join(' and ')}
       group by categoria`,
      paramsCatAnt
    );
    const totalAntPorCategoria = new Map(filasCategoriaAnt.map((f) => [f.categoria, Number(f.total)]));
    const clavesCategorias = new Set([...porCategoria.map((c) => c.clave), ...totalAntPorCategoria.keys()]);
    const comparativaCategorias = [...clavesCategorias]
      .map((clave) => {
        const info = categoriaPorClave(clave);
        const actual = (porCategoria.find((c) => c.clave === clave) || {}).total || 0;
        const anterior = totalAntPorCategoria.get(clave) || 0;
        return {
          clave,
          etiqueta: info ? info.etiqueta : clave,
          actual,
          anterior,
          diferencia: actual - anterior,
          variacion: variacion(actual, anterior),
        };
      })
      .filter((c) => c.actual > 0 || c.anterior > 0)
      .sort((a, b) => b.diferencia - a.diferencia);

    // Evolución mensual (últimos 12 meses) — solo gasto. La variación de
    // cada mes es contra el mes inmediato anterior de esta misma lista
    // (para ver la tendencia mes a mes), no contra el año pasado.
    const desdeEvolucion = primerDiaMesesAtras(hoy, 11);
    const condEvolGasto = [CONDICION_NO_MERCADERIA, `fecha::date >= $1`];
    const paramsEvolGasto = [desdeEvolucion];
    if (categoria) { paramsEvolGasto.push(categoria); condEvolGasto.push(`categoria = $${paramsEvolGasto.length}`); }
    if (subtipo) { paramsEvolGasto.push(subtipo); condEvolGasto.push(`subtipo = $${paramsEvolGasto.length}`); }
    const { rows: evolGastoRows } = await pool.query(
      `select to_char(date_trunc('month', fecha), 'YYYY-MM') as mes,
              coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
       from facturas_compra where ${condEvolGasto.join(' and ')}
       group by 1`,
      paramsEvolGasto
    );
    const evolGastoMap = new Map(evolGastoRows.map((f) => [f.mes, f]));
    const evolucionMensual = [];
    for (let i = 11; i >= 0; i--) {
      const clave = primerDiaMesesAtras(hoy, i).slice(0, 7);
      const g = evolGastoMap.get(clave);
      evolucionMensual.push({ mes: clave, gasto: g ? Number(g.total) : 0, cantidad: g ? g.cantidad : 0 });
    }
    evolucionMensual.forEach((m, i) => {
      m.variacionMensual = i === 0 ? null : variacion(m.gasto, evolucionMensual[i - 1].gasto);
    });

    // --- Oportunidades de ahorro ---
    //
    // Las dos consultas de acá abajo trabajan sobre los RENGLONES de cada
    // factura (facturas_compra_items), no sobre el total de la factura,
    // porque lo que interesa comparar es el precio unitario de un mismo
    // concepto — no el total de una factura, que mezcla cosas distintas.
    // El "concepto" se arma normalizando la descripción cargada a mano
    // (minúsculas, sin espacios de sobra): si dos renglones se
    // escribieron distinto para lo mismo (p.ej. "flete mensual" vs
    // "Flete Mensual "), hoy no se agrupan juntos — no hay forma de saber
    // que son lo mismo sin un catálogo de conceptos, y estas categorías
    // son justamente de texto libre, sin vínculo con el catálogo de
    // artículos. Para que esto rinda al máximo, conviene cargar la
    // descripción siempre de la misma forma en los gastos que se repiten
    // mes a mes (mismo proveedor, mismo concepto).
    const condConcepto = [`f.categoria not in ('mercaderia','flete_mercaderia')`, `fi.descripcion is not null`, `f.fecha::date >= $1`, `f.fecha::date <= $2`];
    const paramsConcepto = [desde, hasta];
    if (categoria) { paramsConcepto.push(categoria); condConcepto.push(`f.categoria = $${paramsConcepto.length}`); }
    if (subtipo) { paramsConcepto.push(subtipo); condConcepto.push(`f.subtipo = $${paramsConcepto.length}`); }
    const { rows: filasConcepto } = await pool.query(
      `select f.categoria, f.subtipo, lower(trim(fi.descripcion)) as concepto,
              p.nombre as proveedor_nombre,
              sum(fi.cantidad)::numeric as cantidad_total,
              sum(fi.cantidad * fi.precio_unitario)::numeric as monto_total
       from facturas_compra_items fi
       join facturas_compra f on f.id = fi.factura_id
       join proveedores p on p.id = f.proveedor_id
       where ${condConcepto.join(' and ')}
       group by f.categoria, f.subtipo, concepto, p.id, p.nombre`,
      paramsConcepto
    );
    const conceptoProveedorMap = new Map();
    for (const fila of filasConcepto) {
      const clave = `${fila.categoria}|${fila.subtipo || ''}|${fila.concepto}`;
      if (!conceptoProveedorMap.has(clave)) {
        conceptoProveedorMap.set(clave, {
          categoriaEtiqueta: (categoriaPorClave(fila.categoria) || {}).etiqueta || fila.categoria,
          subtipo: fila.subtipo,
          concepto: fila.concepto,
          proveedores: [],
        });
      }
      const cantidad = Number(fila.cantidad_total);
      const monto = Number(fila.monto_total);
      conceptoProveedorMap.get(clave).proveedores.push({
        nombre: fila.proveedor_nombre,
        precioPromedio: cantidad ? monto / cantidad : 0,
      });
    }
    // Solo interesan los conceptos que aparecen con 2+ proveedores
    // distintos en el período (si no, no hay con qué comparar) y donde
    // la diferencia es real (5% o más) — menos que eso suele ser solo
    // redondeo o una diferencia puntual de IVA, no algo para actuar.
    const comparativaProveedores = [...conceptoProveedorMap.values()]
      .filter((c) => c.proveedores.length >= 2)
      .map((c) => {
        const proveedores = [...c.proveedores].sort((a, b) => a.precioPromedio - b.precioPromedio);
        const masBarato = proveedores[0];
        const masCaro = proveedores[proveedores.length - 1];
        const ahorroPct = masCaro.precioPromedio ? ((masCaro.precioPromedio - masBarato.precioPromedio) / masCaro.precioPromedio) * 100 : 0;
        return { ...c, proveedores, masBarato, masCaro, ahorroPct };
      })
      .filter((c) => c.ahorroPct >= 5)
      .sort((a, b) => b.ahorroPct - a.ahorroPct)
      .slice(0, 8);

    // Evolución de precio por concepto — últimos 12 meses, NO sujeto al
    // filtro de fecha de arriba (para ver una tendencia hace falta más
    // historia que un período corto). Mismo criterio de "concepto" que
    // la comparación de proveedores, pero acá comparado contra sí mismo
    // mes a mes, para detectar qué viene subiendo más rápido.
    const condEvolConcepto = [`f.categoria not in ('mercaderia','flete_mercaderia')`, `fi.descripcion is not null`, `f.fecha >= $1`];
    const paramsEvolConcepto = [desdeEvolucion];
    if (categoria) { paramsEvolConcepto.push(categoria); condEvolConcepto.push(`f.categoria = $${paramsEvolConcepto.length}`); }
    if (subtipo) { paramsEvolConcepto.push(subtipo); condEvolConcepto.push(`f.subtipo = $${paramsEvolConcepto.length}`); }
    const { rows: filasEvolConcepto } = await pool.query(
      `select f.categoria, f.subtipo, lower(trim(fi.descripcion)) as concepto,
              p.nombre as proveedor_nombre,
              to_char(date_trunc('month', f.fecha), 'YYYY-MM') as mes,
              sum(fi.cantidad)::numeric as cantidad_total,
              sum(fi.cantidad * fi.precio_unitario)::numeric as monto_total
       from facturas_compra_items fi
       join facturas_compra f on f.id = fi.factura_id
       join proveedores p on p.id = f.proveedor_id
       where ${condEvolConcepto.join(' and ')}
       group by f.categoria, f.subtipo, concepto, p.nombre, mes
       order by mes`,
      paramsEvolConcepto
    );
    const evolConceptoMap = new Map();
    for (const fila of filasEvolConcepto) {
      const clave = `${fila.categoria}|${fila.subtipo || ''}|${fila.concepto}|${fila.proveedor_nombre}`;
      if (!evolConceptoMap.has(clave)) {
        evolConceptoMap.set(clave, {
          categoriaEtiqueta: (categoriaPorClave(fila.categoria) || {}).etiqueta || fila.categoria,
          subtipo: fila.subtipo,
          concepto: fila.concepto,
          proveedorNombre: fila.proveedor_nombre,
          puntos: [],
        });
      }
      const cantidad = Number(fila.cantidad_total);
      const monto = Number(fila.monto_total);
      evolConceptoMap.get(clave).puntos.push({ mes: fila.mes, precio: cantidad ? monto / cantidad : 0 });
    }
    const evolucionPrecioConcepto = [...evolConceptoMap.values()]
      .filter((c) => c.puntos.length >= 2)
      .map((c) => {
        const primero = c.puntos[0];
        const ultimo = c.puntos[c.puntos.length - 1];
        return { ...c, primero, ultimo, variacion: variacion(ultimo.precio, primero.precio) };
      })
      // Acá solo interesa lo que subió — para eso es esta sección (ver
      // "Proveedores" arriba para dónde ya se paga distinto por lo mismo).
      .filter((c) => c.variacion !== null && c.variacion > 0)
      .sort((a, b) => b.variacion - a.variacion)
      .slice(0, 8);

    // Por día de la semana y por semana del mes, dentro del período
    // elegido — para ver si hay días o semanas que concentran más gasto.
    const [{ rows: dowGastoRows }, { rows: semGastoRows }] = await Promise.all([
      pool.query(
        `select extract(isodow from fecha)::int as dow,
                coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
         from facturas_compra where ${condCat.join(' and ')}
         group by 1`,
        paramsCat
      ),
      pool.query(
        `select ceil(extract(day from fecha)/7.0)::int as semana,
                coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
         from facturas_compra where ${condCat.join(' and ')}
         group by 1`,
        paramsCat
      ),
    ]);
    const dowGastoMap = new Map(dowGastoRows.map((f) => [f.dow, f]));
    const porDiaSemana = NOMBRES_DIA.map((nombre, idx) => {
      const g = dowGastoMap.get(idx + 1);
      return { nombre, gasto: g ? Number(g.total) : 0, cantidad: g ? g.cantidad : 0 };
    });
    const semGastoMap = new Map(semGastoRows.map((f) => [f.semana, f]));
    const porSemanaMes = [1, 2, 3, 4, 5].map((semana) => {
      const g = semGastoMap.get(semana);
      return { semana, gasto: g ? Number(g.total) : 0, cantidad: g ? g.cantidad : 0 };
    });

    res.render('informes/gastos', {
      filtros: { desde, hasta, categoria, subtipo },
      rangosRapidos: armarRangosRapidos(hoy),
      categorias: CATEGORIAS_GASTO,
      resumen,
      porCategoria,
      categoriaTop,
      maxCategoria,
      comparativaCategorias,
      evolucionMensual,
      comparativaProveedores,
      evolucionPrecioConcepto,
      porDiaSemana,
      porSemanaMes,
      hoy,
    });
  } catch (err) { next(err); }
});

async function totalesCompraMercaderia({ desde, hasta }) {
  const { rows } = await pool.query(
    `select coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
     from facturas_compra where ${CONDICION_MERCADERIA} and fecha::date >= $1 and fecha::date <= $2`,
    [desde, hasta]
  );
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad };
}

// Margen "a la manera del negocio": lo vendido contra lo comprado de
// mercadería en el mismo período — no es un costo de mercadería vendida
// calculado producto por producto (para eso habría que llevar costo
// promedio ponderado por artículo), es la misma cuenta rápida que ya
// venían haciendo a mano. Null si no hubo ventas en el período, para no
// dividir por cero. Misma fórmula (ventas - costo) / ventas se reutiliza
// para el margen de mercadería (costo = mercadería + flete) y para el
// margen real del período (costo = TODO lo cargado en Compras, de
// cualquier categoría) — lo único que cambia es qué se suma como costo.
function margenMercaderia(venta, compra) {
  if (!venta) return null;
  return ((venta - compra) / venta) * 100;
}

// Total de TODO lo cargado en Compras en el período, sin filtrar por
// categoría — mercadería, flete, y también los gastos operativos
// (servicios, sueldos, alquileres, etc.). Sirve para el "margen real del
// período", la rentabilidad de fondo del negocio contra TODO lo que
// salió, no solo el costo de la mercadería que se revende.
async function totalesComprasTodo({ desde, hasta }) {
  const { rows } = await pool.query(
    `select coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
     from facturas_compra where fecha::date >= $1 and fecha::date <= $2`,
    [desde, hasta]
  );
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad };
}

router.get('/ventas', async (req, res, next) => {
  try {
    const hoy = hoyAr();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : primerDiaMes(hoy);
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : hoy;

    const dias = diasEntre(desde, hasta);
    const desdeAnt = sumarDias(desde, -dias);
    const hastaAnt = sumarDias(desde, -1);

    const [ventaActual, ventaAnterior, mercActual, mercAnterior, comprasTodoActual, comprasTodoAnterior] = await Promise.all([
      totalesVenta({ desde, hasta }),
      totalesVenta({ desde: desdeAnt, hasta: hastaAnt }),
      totalesCompraMercaderia({ desde, hasta }),
      totalesCompraMercaderia({ desde: desdeAnt, hasta: hastaAnt }),
      totalesComprasTodo({ desde, hasta }),
      totalesComprasTodo({ desde: desdeAnt, hasta: hastaAnt }),
    ]);

    const margenActual = margenMercaderia(ventaActual.total, mercActual.total);
    const margenAnterior = margenMercaderia(ventaAnterior.total, mercAnterior.total);
    const margenRealActual = margenMercaderia(ventaActual.total, comprasTodoActual.total);
    const margenRealAnterior = margenMercaderia(ventaAnterior.total, comprasTodoAnterior.total);

    const resumen = {
      venta: { ...ventaActual, variacion: variacion(ventaActual.total, ventaAnterior.total) },
      mercaderia: { ...mercActual, variacion: variacion(mercActual.total, mercAnterior.total) },
      margen: {
        valor: margenActual,
        variacionPuntos: margenActual !== null && margenAnterior !== null ? margenActual - margenAnterior : null,
      },
      margenReal: {
        valor: margenRealActual,
        variacionPuntos: margenRealActual !== null && margenRealAnterior !== null ? margenRealActual - margenRealAnterior : null,
      },
    };

    // Evolución mensual (últimos 12 meses): ventas, compra de mercadería
    // y margen resultante, mes por mes — para comparar entre meses.
    const desdeEvolucion = primerDiaMesesAtras(hoy, 11);
    const [{ rows: evolVentaRows }, { rows: evolMercRows }] = await Promise.all([
      pool.query(
        `select to_char(date_trunc('month', v.fecha), 'YYYY-MM') as mes,
                coalesce(sum(v.total),0)::numeric as total,
                coalesce(sum(vi.cantidad),0)::numeric as unidades
         from ventas v
     left join (select venta_id, sum(cantidad) as cantidad from ventas_items group by venta_id) vi on vi.venta_id = v.id
         where v.fecha >= $1
         group by 1`,
        [desdeEvolucion]
      ),
      pool.query(
        `select to_char(date_trunc('month', fecha), 'YYYY-MM') as mes,
                coalesce(sum(total),0)::numeric as total
         from facturas_compra
         where ${CONDICION_MERCADERIA} and fecha::date >= $1
         group by 1`,
        [desdeEvolucion]
      ),
    ]);
    const evolVentaMap = new Map(evolVentaRows.map((f) => [f.mes, f]));
    const evolMercMap = new Map(evolMercRows.map((f) => [f.mes, f]));
    const evolucionMensual = [];
    for (let i = 11; i >= 0; i--) {
      const clave = primerDiaMesesAtras(hoy, i).slice(0, 7);
      const v = evolVentaMap.get(clave);
      const m = evolMercMap.get(clave);
      const totalVenta = v ? Number(v.total) : 0;
      const totalMerc = m ? Number(m.total) : 0;
      evolucionMensual.push({
        mes: clave,
        venta: totalVenta,
        unidades: v ? Number(v.unidades) : 0,
        mercaderia: totalMerc,
        margen: margenMercaderia(totalVenta, totalMerc),
      });
    }

    // Evolución anual: todos los años con datos (no solo los últimos
    // 12 meses) — para comparar entre años, además de entre meses.
    const [{ rows: anioVentaRows }, { rows: anioMercRows }] = await Promise.all([
      pool.query(
        `select extract(year from v.fecha)::int as anio,
                coalesce(sum(v.total),0)::numeric as total,
                coalesce(sum(vi.cantidad),0)::numeric as unidades
         from ventas v
     left join (select venta_id, sum(cantidad) as cantidad from ventas_items group by venta_id) vi on vi.venta_id = v.id
         group by 1 order by 1`
      ),
      pool.query(
        `select extract(year from fecha)::int as anio, coalesce(sum(total),0)::numeric as total
         from facturas_compra where ${CONDICION_MERCADERIA}
         group by 1 order by 1`
      ),
    ]);
    const aniosSet = new Set([...anioVentaRows.map((f) => f.anio), ...anioMercRows.map((f) => f.anio)]);
    const anioVentaMap = new Map(anioVentaRows.map((f) => [f.anio, f]));
    const anioMercMap = new Map(anioMercRows.map((f) => [f.anio, f]));
    const evolucionAnual = [...aniosSet].sort().map((anio) => {
      const v = anioVentaMap.get(anio);
      const m = anioMercMap.get(anio);
      const totalVenta = v ? Number(v.total) : 0;
      const totalMerc = m ? Number(m.total) : 0;
      return {
        anio,
        venta: totalVenta,
        unidades: v ? Number(v.unidades) : 0,
        mercaderia: totalMerc,
        margen: margenMercaderia(totalVenta, totalMerc),
      };
    });

    // Actividad por artículo en el período elegido y en el período
    // anterior equivalente — de acá salen tanto el ranking de productos
    // más vendidos como las recomendaciones de estrella/oportunidad.
    const { rows: actividadRows } = await pool.query(
      `with actual as (
         select vi.articulo_id, sum(vi.subtotal)::numeric as total, sum(vi.cantidad)::numeric as cantidad
         from ventas_items vi join ventas v on v.id = vi.venta_id
         where v.fecha::date >= $1 and v.fecha::date <= $2
         group by vi.articulo_id
       ), anterior as (
         select vi.articulo_id, sum(vi.subtotal)::numeric as total, sum(vi.cantidad)::numeric as cantidad
         from ventas_items vi join ventas v on v.id = vi.venta_id
         where v.fecha::date >= $3 and v.fecha::date <= $4
         group by vi.articulo_id
       )
       select a.id as articulo_id, a.codigo, a.nombre, a.costo,
              coalesce(act.total,0)::numeric as total_actual, coalesce(act.cantidad,0)::numeric as cantidad_actual,
              coalesce(ant.total,0)::numeric as total_anterior, coalesce(ant.cantidad,0)::numeric as cantidad_anterior
       from articulos a
       left join actual act on act.articulo_id = a.id
       left join anterior ant on ant.articulo_id = a.id
       where coalesce(act.total,0) > 0 or coalesce(ant.total,0) > 0`,
      [desde, hasta, desdeAnt, hastaAnt]
    );
    const actividad = actividadRows.map((r) => ({
      articuloId: r.articulo_id,
      codigo: r.codigo,
      nombre: r.nombre,
      costoActual: Number(r.costo),
      totalActual: Number(r.total_actual),
      cantidadActual: Number(r.cantidad_actual),
      totalAnterior: Number(r.total_anterior),
      cantidadAnterior: Number(r.cantidad_anterior),
    }));

    const rankingPorMonto = [...actividad].sort((a, b) => b.totalActual - a.totalActual).slice(0, 10);
    const rankingPorCantidad = [...actividad].sort((a, b) => b.cantidadActual - a.cantidadActual).slice(0, 10);
    const maxMonto = rankingPorMonto.length ? rankingPorMonto[0].totalActual : 0;
    const maxCantidad = rankingPorCantidad.length ? rankingPorCantidad[0].cantidadActual : 0;

    // Margen por producto: ventas del producto en el período contra el
    // costo del artículo (el que hoy tiene cargado, el mismo que ya se
    // pisa desde Compras al confirmar mercadería) multiplicado por lo
    // vendido. No es el costo exacto de LO QUE se compró en ese período
    // puntual para ese producto — eso mezclaría compras y ventas que no
    // necesariamente coinciden en el tiempo, artículo por artículo — pero
    // es la mejor referencia de rentabilidad por producto que se puede
    // dar con el costo vigente, y usa tanto compras (de ahí viene el
    // costo) como ventas (ingreso y cantidad).
    const margenPorProducto = actividad
      .filter((a) => a.totalActual > 0)
      .map((a) => ({
        ...a,
        margenPct: ((a.totalActual - a.costoActual * a.cantidadActual) / a.totalActual) * 100,
      }))
      .sort((a, b) => b.margenPct - a.margenPct);
    const rankingPorMargen = margenPorProducto.slice(0, 10);

    // Recomendaciones — reglas simples, no un modelo: "estrella" son los
    // que más venden y no cayeron respecto al período anterior;
    // "oportunidad" son los que vendían por encima del promedio y
    // cayeron 30% o más — para prestarles atención (revisar precio,
    // stock, o armar una promo).
    const conVentaAnterior = actividad.filter((a) => a.totalAnterior > 0);
    const promedioAnterior = conVentaAnterior.length
      ? conVentaAnterior.reduce((acc, a) => acc + a.totalAnterior, 0) / conVentaAnterior.length
      : 0;

    const estrella = [...actividad]
      .sort((a, b) => b.totalActual - a.totalActual)
      .slice(0, 5)
      .filter((a) => a.totalActual > 0 && (a.totalAnterior === 0 || a.totalActual >= a.totalAnterior))
      .map((a) => ({ ...a, variacion: a.totalAnterior ? variacion(a.totalActual, a.totalAnterior) : null }));

    const UMBRAL_CAIDA_OPORTUNIDAD = 30;
    const oportunidad = conVentaAnterior
      .filter((a) => a.totalAnterior >= promedioAnterior)
      .map((a) => ({ ...a, caida: ((a.totalAnterior - a.totalActual) / a.totalAnterior) * 100 }))
      .filter((a) => a.caida >= UMBRAL_CAIDA_OPORTUNIDAD)
      .sort((a, b) => b.totalAnterior - a.totalAnterior)
      .slice(0, 5);

    res.render('informes/ventas', {
      filtros: { desde, hasta },
      rangosRapidos: armarRangosRapidos(hoy),
      resumen,
      evolucionMensual,
      evolucionAnual,
      rankingPorMonto,
      rankingPorCantidad,
      maxMonto,
      maxCantidad,
      rankingPorMargen,
      margenPorProducto,
      estrella,
      oportunidad,
      hoy,
    });
  } catch (err) { next(err); }
});

module.exports = router;
