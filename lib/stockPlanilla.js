// Sincronización de stock contra una hoja de Google Sheets externa — el
// modo puente para mientras el depósito propio está en refacción y el
// stock real vive en la planilla de otro local (ver stock_config.modo).
// Se lee la hoja publicada como CSV, se cruza por código contra los
// artículos existentes y se pisa articulos.stock con lo que diga la
// planilla en ese momento — la diferencia queda en el historial
// (stock_movimientos, tipo "sincronizacion") igual que cualquier otro
// movimiento, vía registrarMovimiento (así no hay dos formas de tocar
// articulos.stock).
const pool = require('../db/pool');
const { parseNumeroAr } = require('./numeros');
const { registrarMovimiento } = require('./stock');

// Acepta el link "normal" (de compartir o de editar, con o sin gid en la
// URL) y arma la URL de exportación CSV de esa pestaña puntual —
// docs.google.com redirige internamente a la descarga real, cosa que
// fetch() sigue solo.
function urlExportCsv(sheetUrl) {
  const idMatch = String(sheetUrl || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const gidMatch = String(sheetUrl).match(/gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

// Parser de CSV mínimo pero que respeta comillas — imprescindible acá
// porque los valores vienen con coma decimal entre comillas (ej.
// "43,62"), y separar por comas a lo bruto los partiría mal.
function parseCsv(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else entreComillas = false;
      } else {
        campo += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      fila.push(campo); campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((v) => v !== '')) filas.push(fila);
      fila = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || fila.length) {
    fila.push(campo);
    if (fila.some((v) => v !== '')) filas.push(fila);
  }
  return filas;
}

// La hoja usa tanto "0" como la palabra "null" para decir "no hay
// stock de esto" — las dos cuentan como cantidad 0, no como un dato
// faltante (que sí se deja sin tocar, ver "sinCantidad" más abajo).
function interpretarCantidad(textoCelda) {
  const t = String(textoCelda || '').trim();
  if (t === '') return null;
  if (/^null$/i.test(t)) return 0;
  return parseNumeroAr(t);
}

async function leerFilasDeLaPlanilla(sheetUrl) {
  const url = urlExportCsv(sheetUrl);
  if (!url) throw new Error('El link de la hoja no parece un link de Google Sheets válido.');

  let resp;
  try {
    resp = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('No se pudo conectar con Google Sheets: ' + err.message);
  }
  if (!resp.ok) {
    throw new Error(
      `Google Sheets respondió ${resp.status} al exportar la hoja — revisá que esté compartida como "Cualquier persona con el enlace puede ver".`
    );
  }
  const texto = await resp.text();
  const filas = parseCsv(texto);
  if (filas.length < 2) {
    throw new Error('La hoja no tiene filas de datos (o no se pudo leer bien).');
  }

  const encabezado = filas[0].map((h) => String(h).trim().toLowerCase());
  const iCodigo = encabezado.findIndex((h) => ['cod', 'código', 'codigo', 'cod.'].includes(h));
  const iStock = encabezado.findIndex((h) => ['stock', 'cantidad'].includes(h));
  if (iCodigo === -1 || iStock === -1) {
    throw new Error('No encontré las columnas "Cod" y "Stock" en la primera fila de esa pestaña.');
  }

  return filas.slice(1)
    .map((f) => ({
      codigo: (f[iCodigo] || '').trim(),
      cantidad: interpretarCantidad(f[iStock]),
    }))
    .filter((f) => f.codigo !== '');
}

// Corre la sincronización completa: lee la planilla, cruza por código
// contra los artículos activos y pisa el stock de los que coincidan,
// dejando el movimiento en el historial. Devuelve un resumen (en vez de
// asumir que todo cruzó bien) para poder avisar en la pantalla qué
// códigos de la hoja no existen como artículo, y qué artículos no
// aparecen en la hoja.
async function sincronizarStockDesdePlanilla({ sheetUrl, nombrePlanilla, usuarioId }) {
  const filas = await leerFilasDeLaPlanilla(sheetUrl);

  const { rows: articulos } = await pool.query('select id, codigo, stock from articulos where activo = true');
  const porCodigo = new Map(articulos.map((a) => [String(a.codigo).trim().toLowerCase(), a]));

  const noEncontrados = [];
  const sinCantidad = [];
  const codigosDeLaHoja = new Set();
  let actualizados = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const fila of filas) {
      const claveNormalizada = fila.codigo.toLowerCase();
      codigosDeLaHoja.add(claveNormalizada);
      const articulo = porCodigo.get(claveNormalizada);
      if (!articulo) { noEncontrados.push(fila.codigo); continue; }
      if (fila.cantidad === null) { sinCantidad.push(fila.codigo); continue; }

      // Si el artículo nunca se tocó en Stock, articulo.stock viene en
      // null (no en 0) — hay que forzar el movimiento aunque el delta
      // calculado sea 0, para que quede el 0 real guardado en vez de
      // seguir en null (que se muestra como "—", no como "sin stock").
      const nuncaSincronizado = articulo.stock === null || articulo.stock === undefined;
      const stockActual = Number(articulo.stock) || 0;
      const delta = Math.round((fila.cantidad - stockActual) * 100) / 100;
      if (delta !== 0 || nuncaSincronizado) {
        await registrarMovimiento(client, {
          articuloId: articulo.id,
          tipo: 'sincronizacion',
          cantidad: delta,
          motivo: `Sincronización con "${nombrePlanilla || 'la planilla'}"`,
          usuarioId: usuarioId || null,
        });
        actualizados++;
      }
    }
    await client.query('update stock_config set ultima_sincronizacion = now(), ultimo_error = null where id = 1');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const sinDatoEnHoja = articulos
    .map((a) => a.codigo)
    .filter((cod) => !codigosDeLaHoja.has(String(cod).trim().toLowerCase()));

  return { actualizados, noEncontrados, sinCantidad, sinDatoEnHoja };
}

module.exports = { sincronizarStockDesdePlanilla, urlExportCsv };
