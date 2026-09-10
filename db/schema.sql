-- Ruta Fría — esquema de base de datos, Fase 1
-- Postgres. Pensado para correr en Render (Postgres administrado).

create table if not exists config (
  clave text primary key,
  valor numeric not null
);

-- valores por defecto: los porcentajes fijos y el recargo por medio de pago,
-- todos editables desde una sola pantalla de configuración
insert into config (clave, valor) values
  ('iva_pct', 21),
  ('iibb_pct', 3.5),
  ('recargo_lista_pct', 10)
on conflict (clave) do nothing;

create table if not exists proveedores (
  id serial primary key,
  nombre text not null,
  contacto text,
  telefono text,
  created_at timestamptz not null default now()
);

create table if not exists clientes (
  id serial primary key,
  razon_social text not null,
  nombre_contacto text,
  telefono text,
  direccion text,
  condicion_iva text,        -- Responsable Inscripto / Monotributo / Consumidor Final
  cuit_dni text,
  condicion_pago text,       -- contado / cuenta_corriente
  notas text,
  created_at timestamptz not null default now()
);

create table if not exists articulos (
  id serial primary key,
  codigo text not null unique,
  nombre text not null,
  unidad text not null default 'kg',   -- kg / cajon / bolsa / unidad
  costo numeric not null default 0,     -- lo pisa la última factura de compra confirmada
  aplica_iva boolean not null default true,
  aplica_iibb boolean not null default true,
  flete_pct numeric not null default 0,
  margen_pct numeric not null default 0,
  stock numeric,                        -- aproximado, opcional en fase 1
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- gramos por unidad de venta, solo para artículos con unidad = 'unidad' cuyo
-- costo se sigue cargando por kg (ej. un producto que viene en paquetes de
-- 200g pero en la factura del proveedor figura el precio del kilo).
-- alter table (en vez de una columna más arriba) porque la tabla ya existía
-- en producción antes de agregar este campo.
alter table articulos add column if not exists contenido_gr numeric;

create table if not exists facturas_compra (
  id serial primary key,
  proveedor_id integer references proveedores(id),
  numero text,
  fecha date not null default current_date,
  actualizo_costos boolean not null default false, -- si esta factura se confirmó para pisar costos
  total numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists facturas_compra_items (
  id serial primary key,
  factura_id integer not null references facturas_compra(id) on delete cascade,
  articulo_id integer not null references articulos(id),
  cantidad numeric not null,
  precio_unitario numeric not null,
  aplica_iva boolean not null default true,
  total numeric not null
);

create table if not exists gastos (
  id serial primary key,
  fecha date not null default current_date,
  proveedor_beneficiario text not null,
  tipo text not null,        -- Mercadería / Sueldo / Alquiler / Insumo / Mantenimiento / Inversión / Impuesto / Servicio / Publicidad / Mobiliario / Otros
  subtipo text,
  monto numeric not null,
  factura_compra_id integer references facturas_compra(id),  -- se completa solo si viene de Compras
  notas text,
  created_at timestamptz not null default now()
);

create table if not exists ventas (
  id serial primary key,
  numero_remito serial,
  cliente_id integer not null references clientes(id),
  fecha timestamptz not null default now(),
  forma_pago text not null,   -- efectivo / transferencia / cuenta_corriente
  estado text not null default 'emitido',  -- emitido / entregado / cobrado
  origen text not null default 'deposito', -- deposito / calle (preventista) — para el seguimiento de fase 3
  total numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists ventas_items (
  id serial primary key,
  venta_id integer not null references ventas(id) on delete cascade,
  articulo_id integer not null references articulos(id),
  cantidad numeric not null,
  precio_unitario numeric not null,
  subtotal numeric not null
);

create index if not exists idx_facturas_compra_items_factura on facturas_compra_items(factura_id);
create index if not exists idx_ventas_items_venta on ventas_items(venta_id);
create index if not exists idx_gastos_fecha on gastos(fecha);
create index if not exists idx_ventas_fecha on ventas(fecha);
