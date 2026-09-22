# Ruta Fría

Sistema de gestión para el mayorista de pescados congelados. Node.js + Express + PostgreSQL, pensado para correr en Render.

## Qué hay hecho hasta ahora (Fase 1, en progreso)

- **Clientes** — alta, edición y listado. ✅ funcionando
- **Artículos** — alta, edición, listado, con la calculadora de precio (costo + IVA/IIBB + flete + margen → precio en efectivo → precio de lista). ✅ funcionando
- **Usuarios** — login, alta de usuarios, permisos por módulo, rol de administrador. ✅ funcionando
- **Compras** (facturas de proveedores) — proveedores (alta y listado) y facturas de compra con renglones por artículo. Una factura arranca en borrador (se puede seguir editando o borrar) y al confirmarla pisa el costo de cada artículo con el precio unitario cargado — a partir de ahí queda de solo lectura, salvo para quien tenga el permiso especial de corregir facturas confirmadas. ✅ funcionando
- **Historial de visitas** (prospectos, `/prospectos`) — carga de potenciales clientes con su dirección, geocodificada automáticamente (Nominatim/OpenStreetMap, con ajuste manual arrastrando el pin) y mostrada en un mapa (Leaflet) donde el tamaño de cada punto crece con la cantidad de visitas registradas. Separado a propósito de Clientes. ✅ funcionando
- **Gastos generales** — pantalla placeholder, todavía sin construir
- **Venta / remito** — pantalla placeholder, todavía sin construir

## Correr en local

Necesitás Node 18+ y una base Postgres (local o remota).

```bash
npm install
cp .env.example .env      # completar DATABASE_URL con tu Postgres local
npm run db:init           # crea las tablas
npm start                 # http://localhost:3000
```

## Desplegar en Render

1. Subir este repositorio a GitHub.
2. En Render: **New → Blueprint** (o a mano: un **Web Service** apuntando al repo, build command `npm install`, start command `npm start`) y una **Postgres** — Render conecta sola la variable `DATABASE_URL` del web service con la base.
3. Una sola vez, desde la consola/Shell del web service en Render: `npm run db:init` (aplica `db/schema.sql`).

## Backup de la base de datos

Todos los días a las 03:00 (hora Argentina) corre solo un workflow de
GitHub Actions (`.github/workflows/backup-db.yml`) que hace un dump
completo de la base y lo sube como un archivo nuevo al repositorio
privado `riomar-pescaderia/ruta-fria-backups` (separado de este repo, a
propósito, para no mezclar código con datos). Se conservan los últimos
90 días — después de eso, los backups más viejos se van borrando solos
del repo de backups.

**Configuración (una sola vez):**

1. Crear un repositorio nuevo, **privado**, en GitHub:
   `riomar-pescaderia/ruta-fria-backups` (puede quedar vacío).
2. Generar un token de acceso personal de GitHub — fine-grained
   (Settings → Developer settings → Personal access tokens → Fine-grained
   tokens) — con acceso **solo** a ese repositorio y permiso "Contents:
   Read and write".
3. En este repositorio (`ruta-fria`) → Settings → Secrets and variables
   → Actions → "New repository secret", agregar dos:
   - `DATABASE_URL`: la "External Database URL" de la base (panel de
     Render → la base → pestaña Connect).
   - `BACKUP_REPO_TOKEN`: el token del paso 2.
4. Listo. Se puede probar ya mismo sin esperar al día siguiente: pestaña
   **Actions** → "Backup diario de la base de datos" → "Run workflow".

**Para restaurar un backup** (por ejemplo si hay que recuperar todo
desde cero en una base nueva):

```bash
gunzip -c backup-2026-10-15.sql.gz | psql "postgres://usuario:password@host/basededatos"
```

Con `DATABASE_URL` apuntando a la base nueva (vacía) alcanza con
`psql "$DATABASE_URL" < backup-2026-10-15.sql` después de descomprimir.
Esto no reemplaza tener la base al día en un plan pago de Render (con
sus propios backups automáticos) — es la copia de seguridad aparte, por
si pasa algo con la cuenta de Render, con la base, o con lo que sea.

## Estructura del proyecto

```
db/          esquema de la base y script de inicialización
lib/         lógica compartida (calculadora de precio, config)
routes/      una ruta por módulo (clientes, articulos, ...)
views/       plantillas EJS
public/      CSS
```

## Notas técnicas

- **Geocodificación de direcciones** (Historial de visitas): usa Nominatim (`nominatim.openstreetmap.org`), un servicio gratuito sin API key. Necesita que el servidor tenga salida a internet — en Render funciona sin configuración extra. Si alguna dirección no se encuentra (común en zonas rurales o direcciones informales), el prospecto se guarda igual y el punto se puede marcar a mano arrastrando el pin en el mapa.

## Decisiones pendientes de confirmar

- **Margen de beneficio**: hoy se aplica sobre el costo ya con IVA/IIBB/flete sumados (`lib/precios.js`). Falta confirmar con un par de artículos reales de la planilla si es así o si el margen va sobre el costo solo.
- **Remito**: el modelo genérico está en el plan (documento "Ruta Fría"), pero todavía no se construyó la pantalla de venta que lo genera.
