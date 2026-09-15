// Geocodificación de direcciones con Nominatim (OpenStreetMap) — gratis y
// sin necesidad de cuenta ni API key. La política de uso de Nominatim
// pide identificar la aplicación con un User-Agent propio y no golpear el
// servicio en paralelo/a alta frecuencia; acá el volumen es bajísimo (se
// geocodifica solo cuando se carga o edita un prospecto), así que alcanza
// con respetar el header y no hace falta cola ni caché.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'RutaFria-RiomarPescaderia/1.0 (sistema interno de gestión)';

// Devuelve { lat, lng, etiqueta } con el primer resultado, o null si no
// encontró nada o el servicio falló — nunca tira: quien llama decide qué
// hacer si no hay coordenadas (dejar el prospecto sin ubicar en el mapa,
// para ubicarlo a mano después).
async function geocodificarDireccion(direccion) {
  const texto = String(direccion || '').trim();
  if (!texto) return null;

  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(texto)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const r = data[0];
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, etiqueta: r.display_name || texto };
  } catch (err) {
    console.error('[ruta-fria] error geocodificando dirección:', err.message);
    return null;
  }
}

module.exports = { geocodificarDireccion };
