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
  const cond = [`categoria <> 'mercaderia'`, `fecha::date >= $1`, `fecha::date <= $2`];
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
     from ventas v left join ventas_items vi on vi.venta_id = v.id
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

    const [gastoActual, gastoAnterior, ventaActual, ventaAnterior] = await Promise.all([
      totalesGasto(filtro),
      totalesGasto(filtroAnt),
      totalesVenta(filtro),
      totalesVenta(filtroAnt),
    ]);

    const resultadoActual = ventaActual.total - gastoActual.total;
    const resultadoAnterior = ventaAnterior.total - gastoAnterior.total;

    const resumen = {
      gasto: { ...gastoActual, variacion: variacion(gastoActual.total, gastoAnterior.total) },
      venta: { ...ventaActual, variacion: variacion(ventaActual.total, ventaAnterior.total) },
      resultado: { total: resultadoActual, variacion: variacion(resultadoActual, resultadoAnterior) },
    };

    // Gastos por categoría, con el detalle de subtipo anidado — respeta
    // los mismos filtros que el resumen (si ya se filtró por categoría,
    // esta tabla queda mostrando solo sus subtipos).
    const condCat = [`categoria <> 'mercaderia'`, `fecha::date >= $1`, `fecha::date <= $2`];
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
    porCategoria.forEach((c) => c.subtipos.sort((a, b) => b.total - a.total));

    // Evolución mensual: últimos 12 meses completos hasta el actual,
    // gastos y ventas lado a lado — para comparar entre meses más allá
    // del rango elegido arriba. Respeta el filtro de categoría/subtipo
    // del lado de gastos (ventas no tiene ese concepto).
    const desdeEvolucion = primerDiaMesesAtras(hoy, 11);
    const condEvolGasto = [`categoria <> 'mercaderia'`, `fecha::date >= $1`];
    const paramsEvolGasto = [desdeEvolucion];
    if (categoria) { paramsEvolGasto.push(categoria); condEvolGasto.push(`categoria = $${paramsEvolGasto.length}`); }
    if (subtipo) { paramsEvolGasto.push(subtipo); condEvolGasto.push(`subtipo = $${paramsEvolGasto.length}`); }
    const [{ rows: evolGastoRows }, { rows: evolVentaRows }] = await Promise.all([
      pool.query(
        `select to_char(date_trunc('month', fecha), 'YYYY-MM') as mes,
                coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
         from facturas_compra where ${condEvolGasto.join(' and ')}
         group by 1`,
        paramsEvolGasto
      ),
      pool.query(
        `select to_char(date_trunc('month', v.fecha), 'YYYY-MM') as mes,
                coalesce(sum(v.total),0)::numeric as total, count(distinct v.id)::int as cantidad,
                coalesce(sum(vi.cantidad),0)::numeric as unidades
         from ventas v left join ventas_items vi on vi.venta_id = v.id
         where v.fecha >= $1
         group by 1`,
        [desdeEvolucion]
      ),
    ]);
    const evolGastoMap = new Map(evolGastoRows.map((f) => [f.mes, f]));
    const evolVentaMap = new Map(evolVentaRows.map((f) => [f.mes, f]));
    const evolucionMensual = [];
    for (let i = 11; i >= 0; i--) {
      const clave = primerDiaMesesAtras(hoy, i).slice(0, 7);
      const g = evolGastoMap.get(clave);
      const v = evolVentaMap.get(clave);
      const totalGasto = g ? Number(g.total) : 0;
      const totalVenta = v ? Number(v.total) : 0;
      evolucionMensual.push({
        mes: clave,
        gasto: totalGasto,
        cantidadGasto: g ? g.cantidad : 0,
        venta: totalVenta,
        cantidadVenta: v ? v.cantidad : 0,
        unidadesVenta: v ? Number(v.unidades) : 0,
        resultado: totalVenta - totalGasto,
      });
    }

    // Por día de la semana, dentro del período elegido — para ver si hay
    // días que concentran más gasto o más venta.
    const [{ rows: dowGastoRows }, { rows: dowVentaRows }] = await Promise.all([
      pool.query(
        `select extract(isodow from fecha)::int as dow,
                coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
         from facturas_compra where ${condCat.join(' and ')}
         group by 1`,
        paramsCat
      ),
      pool.query(
        `select extract(isodow from v.fecha)::int as dow,
                coalesce(sum(v.total),0)::numeric as total, count(distinct v.id)::int as cantidad,
                coalesce(sum(vi.cantidad),0)::numeric as unidades
         from ventas v left join ventas_items vi on vi.venta_id = v.id
         where v.fecha::date >= $1 and v.fecha::date <= $2
         group by 1`,
        [desde, hasta]
      ),
    ]);
    const dowGastoMap = new Map(dowGastoRows.map((f) => [f.dow, f]));
    const dowVentaMap = new Map(dowVentaRows.map((f) => [f.dow, f]));
    const porDiaSemana = NOMBRES_DIA.map((nombre, idx) => {
      const dow = idx + 1;
      const g = dowGastoMap.get(dow);
      const v = dowVentaMap.get(dow);
      return {
        nombre,
        gasto: g ? Number(g.total) : 0,
        cantidadGasto: g ? g.cantidad : 0,
        venta: v ? Number(v.total) : 0,
        cantidadVenta: v ? v.cantidad : 0,
        unidadesVenta: v ? Number(v.unidades) : 0,
      };
    });

    // Por semana del mes (1ª a 5ª semana, según el día del mes en que
    // cae cada fecha), dentro del período elegido.
    const [{ rows: semGastoRows }, { rows: semVentaRows }] = await Promise.all([
      pool.query(
        `select ceil(extract(day from fecha)/7.0)::int as semana,
                coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
         from facturas_compra where ${condCat.join(' and ')}
         group by 1`,
        paramsCat
      ),
      pool.query(
        `select ceil(extract(day from v.fecha)/7.0)::int as semana,
                coalesce(sum(v.total),0)::numeric as total, count(distinct v.id)::int as cantidad,
                coalesce(sum(vi.cantidad),0)::numeric as unidades
         from ventas v left join ventas_items vi on vi.venta_id = v.id
         where v.fecha::date >= $1 and v.fecha::date <= $2
         group by 1`,
        [desde, hasta]
      ),
    ]);
    const semGastoMap = new Map(semGastoRows.map((f) => [f.semana, f]));
    const semVentaMap = new Map(semVentaRows.map((f) => [f.semana, f]));
    const porSemanaMes = [1, 2, 3, 4, 5].map((semana) => {
      const g = semGastoMap.get(semana);
      const v = semVentaMap.get(semana);
      return {
        semana,
        gasto: g ? Number(g.total) : 0,
        cantidadGasto: g ? g.cantidad : 0,
        venta: v ? Number(v.total) : 0,
        cantidadVenta: v ? v.cantidad : 0,
        unidadesVenta: v ? Number(v.unidades) : 0,
      };
    });

    res.render('informes/gastos', {
      filtros: { desde, hasta, categoria, subtipo },
      rangosRapidos: armarRangosRapidos(hoy),
      categorias: CATEGORIAS_GASTO,
      resumen,
      porCategoria,
      evolucionMensual,
      porDiaSemana,
      porSemanaMes,
      hoy,
    });
  } catch (err) { next(err); }
});

async function totalesCompraMercaderia({ desde, hasta }) {
  const { rows } = await pool.query(
    `select coalesce(sum(total),0)::numeric as total, count(*)::int as cantidad
     from facturas_compra where categoria = 'mercaderia' and fecha::date >= $1 and fecha::date <= $2`,
    [desde, hasta]
  );
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad };
}

// Margen "a la manera del negocio": lo vendido contra lo comprado de
// mercadería en el mismo período — no es un costo de mercadería vendida
// calculado producto por producto (para eso habría que llevar costo
// promedio ponderado por artículo), es la misma cuenta rápida que ya
// venían haciendo a mano. Null si no hubo ventas en el período, para no
// dividir por cero.
function margenMercaderia(venta, compra) {
  if (!venta) return null;
  return ((venta - compra) / venta) * 100;
}

router.get('/ventas', async (req, res, next) => {
  try {
    const hoy = hoyAr();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : primerDiaMes(hoy);
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : hoy;

    const dias = diasEntre(desde, hasta);
    const desdeAnt = sumarDias(desde, -dias);
    const hastaAnt = sumarDias(desde, -1);

    const [ventaActual, ventaAnterior, mercActual, mercAnterior] = await Promise.all([
      totalesVenta({ desde, hasta }),
      totalesVenta({ desde: desdeAnt, hasta: hastaAnt }),
      totalesCompraMercaderia({ desde, hasta }),
      totalesCompraMercaderia({ desde: desdeAnt, hasta: hastaAnt }),
    ]);

    const margenActual = margenMercaderia(ventaActual.total, mercActual.total);
    const margenAnterior = margenMercaderia(ventaAnterior.total, mercAnterior.total);

    const resumen = {
      venta: { ...ventaActual, variacion: variacion(ventaActual.total, ventaAnterior.total) },
      mercaderia: { ...mercActual, variacion: variacion(mercActual.total, mercAnterior.total) },
      margen: {
        valor: margenActual,
        variacionPuntos: margenActual !== null && margenAnterior !== null ? margenActual - margenAnterior : null,
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
         from ventas v left join ventas_items vi on vi.venta_id = v.id
         where v.fecha >= $1
         group by 1`,
        [desdeEvolucion]
      ),
      pool.query(
        `select to_char(date_trunc('month', fecha), 'YYYY-MM') as mes,
                coalesce(sum(total),0)::numeric as total
         from facturas_compra
         where categoria = 'mercaderia' and fecha::date >= $1
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
         from ventas v left join ventas_items vi on vi.venta_id = v.id
         group by 1 order by 1`
      ),
      pool.query(
        `select extract(year from fecha)::int as anio, coalesce(sum(total),0)::numeric as total
         from facturas_compra where categoria = 'mercaderia'
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
       select a.id as articulo_id, a.codigo, a.nombre,
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
      totalActual: Number(r.total_actual),
      cantidadActual: Number(r.cantidad_actual),
      totalAnterior: Number(r.total_anterior),
      cantidadAnterior: Number(r.cantidad_anterior),
    }));

    const rankingPorMonto = [...actividad].sort((a, b) => b.totalActual - a.totalActual).slice(0, 10);
    const rankingPorCantidad = [...actividad].sort((a, b) => b.cantidadActual - a.cantidadActual).slice(0, 10);
    const maxMonto = rankingPorMonto.length ? rankingPorMonto[0].totalActual : 0;
    const maxCantidad = rankingPorCantidad.length ? rankingPorCantidad[0].cantidadActual : 0;

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
      estrella,
      oportunidad,
      hoy,
    });
  } catch (err) { next(err); }
});

module.exports = router;
