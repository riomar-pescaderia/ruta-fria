// Geocodificación de direcciones con Nominatim (OpenStreetMap) — gratis y
// sin necesidad de cuenta ni API key. La política de uso de Nominatim
// pide identificar la aplicación con un User-Agent propio y no golpear el
// servicio en paralelo/a alta frecuencia; acá el volumen es bajísimo (se
// geocodifica solo cuando se carga o edita un prospecto), así que alcanza
// con respetar el header y no hace falta cola ni caché.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'RutaFria-RiomarPescaderia/1.0 (sistema interno de gestión)';

// Una misma calle y altura existe en varias provincias — para no elegir
// mal solo, se prioriza (sin descartar el resto) la zona donde opera el
// negocio: Chaco y alrededores (Corrientes, Formosa, norte de Santa Fe).
// "bounded=0" hace que esto sea una preferencia, no un filtro estricto:
// si la dirección real está fuera de esta caja, igual puede aparecer.
const VIEWBOX_NEA = '-64.5,-22.0,-57.5,-30.5'; // lon1,lat1,lon2,lat2
const PAIS = 'ar';

// Devuelve hasta "limite" resultados candidatos — [{ lat, lng, etiqueta }]
// — para que la persona elija cuál es el correcto, en vez de asumir que
// el primero es el que quiso decir (una misma calle y altura puede
// repetirse en varias provincias). Nunca tira: si Nominatim falla o no
// encuentra nada, devuelve un array vacío y quien llama decide qué hacer
// (dejar el prospecto sin ubicar, para marcarlo a mano después).
async function buscarDirecciones(direccion, limite) {
  const texto = String(direccion || '').trim();
  if (!texto) return [];

  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: String(limite || 5),
    q: texto,
    countrycodes: PAIS,
    viewbox: VIEWBOX_NEA,
    bounded: '0',
    addressdetails: '1',
  });

  try {
    const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), etiqueta: r.display_name || texto }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch (err) {
    console.error('[ruta-fria] error geocodificando dirección:', err.message);
    return [];
  }
}

// Compatibilidad para el fallback del lado del servidor (cuando se guarda
// un prospecto sin que el formulario haya buscado o elegido una opción):
// se queda con el primer resultado, con la misma prioridad de zona.
async function geocodificarDireccion(direccion) {
  const [primero] = await buscarDirecciones(direccion, 1);
  return primero || null;
}

module.exports = { buscarDirecciones, geocodificarDireccion };
