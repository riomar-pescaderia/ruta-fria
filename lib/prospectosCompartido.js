// Consulta compartida entre Historial de visitas (la lista) y Mapa (el
// mapa de calor) — ambas secciones muestran los mismos prospectos, cada
// una a su manera, así que viven en un solo lugar para no repetir el SQL.
const pool = require('../db/pool');

async function listarConVisitas() {
  const { rows } = await pool.query(`
    select p.*,
           count(distinct v.id)::int as cantidad_visitas,
           max(v.fecha) as ultima_visita,
           c.razon_social as cliente_nombre,
           (select ct.telefono from prospectos_contactos ct
             where ct.prospecto_id = p.id and ct.telefono is not null
             order by ct.orden, ct.id limit 1) as telefono_principal
    from prospectos p
    left join prospectos_visitas v on v.prospecto_id = p.id
    left join clientes c on c.id = p.cliente_id
    where p.activo = true
    group by p.id, c.razon_social
    order by p.nombre
  `);
  return rows;
}

module.exports = { listarConVisitas };
