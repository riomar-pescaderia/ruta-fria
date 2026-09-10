# Ruta Fría

Sistema de gestión para el mayorista de pescados congelados. Node.js + Express + PostgreSQL, pensado para correr en Render.

## Qué hay hecho hasta ahora (Fase 1, en progreso)

- **Clientes** — alta, edición y listado. ✅ funcionando
- **Artículos** — alta, edición, listado, con la calculadora de precio (costo + IVA/IIBB + flete + margen → precio en efectivo → precio de lista). ✅ funcionando
- **Compras** (facturas de proveedores) — pantalla placeholder, todavía sin construir
- **Gastos generales** — pantalla placeholder, todavía sin construir
- **Venta / remito** — pantalla placeholder, todavía sin construir

El costo de cada artículo hoy se carga directo en la base (no hay pantalla para eso todavía) — lo va a completar Compras cuando esté listo.

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

## Estructura del proyecto

```
db/          esquema de la base y script de inicialización
lib/         lógica compartida (calculadora de precio, config)
routes/      una ruta por módulo (clientes, articulos, ...)
views/       plantillas EJS
public/      CSS
```

## Decisiones pendientes de confirmar

- **Margen de beneficio**: hoy se aplica sobre el costo ya con IVA/IIBB/flete sumados (`lib/precios.js`). Falta confirmar con un par de artículos reales de la planilla si es así o si el margen va sobre el costo solo.
- **Remito**: el modelo genérico está en el plan (documento "Ruta Fría"), pero todavía no se construyó la pantalla de venta que lo genera.
