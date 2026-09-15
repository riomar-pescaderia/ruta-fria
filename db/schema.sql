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
  unidad numeric not null default 1,   -- divisor: costo (por kg) ÷ unidad = costo real del producto
  costo numeric not null default 0,     -- lo pisa la última factura de compra confirmada
  aplica_iva boolean not null default true,
  aplica_iibb boolean not null default true,
  flete_pct numeric not null default 0,
  margen_pct numeric not null default 0,
  stock numeric,                        -- aproximado, opcional en fase 1
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- gramos por unidad de venta — quedó sin uso: la división genérica de
-- costo/unidad (más abajo) cubre el mismo caso. La dejamos en la tabla sin
-- tocar para no volver a alterar la base; nada la lee ni la escribe.
alter table articulos add column if not exists contenido_gr numeric;

-- La columna "unidad" pasó de texto categórico (kg/cajon/bolsa/unidad) a
-- ser el divisor numérico que se usa en la fórmula de precio: costo (que
-- siempre se carga por kg) ÷ unidad = costo real del producto que se
-- vende. Esta migración corre una sola vez: normaliza los valores de texto
-- que ya había cargados (incluye formato con coma decimal, "0,75", y algún
-- "kg" suelto cargado a mano) y recién ahí cambia el tipo de columna. Una
-- vez que la columna ya es numeric, este bloque no hace nada en los
-- arranques siguientes.
do $$
begin
  if (select data_type from information_schema.columns
      where table_name = 'articulos' and column_name = 'unidad') = 'text' then
    update articulos set unidad = replace(unidad, ',', '.')
      where unidad ~ '^[0-9]+,[0-9]+$';
    update articulos set unidad = '1'
      where unidad is null or unidad = '' or unidad !~ '^[0-9]+(\.[0-9]+)?$';
    alter table articulos alter column unidad drop default;
    alter table articulos alter column unidad type numeric using unidad::numeric;
    alter table articulos alter column unidad set default 1;
  end if;
end $$;

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

-- Se completa al confirmar la factura, uno por renglón: 'aplicado' (se
-- pisó el costo del artículo), 'no_aplicado' (el usuario decidió no
-- pisarlo en la pantalla de revisión) o 'sin_cambio' (el precio ya
-- coincidía con el costo vigente). Null mientras la factura sigue en
-- borrador.
alter table facturas_compra_items add column if not exists estado_costo text;

-- Desglose neto/IVA de cada renglón, calculado al cargar o editar la
-- factura con el %IVA vigente en ese momento (config.iva_pct) — queda
-- fijo aunque el %IVA cambie después, para no reescribir facturas viejas.
-- Si el renglón no tiene "aplica_iva", neto = total e iva = 0.
alter table facturas_compra_items add column if not exists neto numeric;
alter table facturas_compra_items add column if not exists iva numeric;

-- Historial de visitas a potenciales clientes (prospectos), aparte de
-- Clientes para no mezclar a quien todavía no compró con quien ya
-- concretó una venta. Cada prospecto se carga una vez con su dirección
-- (geocodificada a lat/lng para ubicarlo en el mapa) y después cada
-- visita que se le hace es una fila en prospectos_visitas — así el mapa
-- puede mostrar cuántas veces se visitó cada punto y cuándo.
create table if not exists prospectos (
  id serial primary key,
  nombre text not null,
  contacto text,
  telefono text,
  direccion text not null,
  notas text,
  lat numeric,
  lng numeric,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists prospectos_visitas (
  id serial primary key,
  prospecto_id integer not null references prospectos(id) on delete cascade,
  fecha date not null default current_date,
  nota text,
  created_at timestamptz not null default now()
);

create index if not exists idx_prospectos_visitas_prospecto on prospectos_visitas(prospecto_id);

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

create table if not exists usuarios (
  id serial primary key,
  username text not null unique,
  password_hash text not null,
  nombre text,
  activo boolean not null default true,
  es_admin boolean not null default false,       -- acceso total, incluida la gestión de usuarios
  acceso_clientes boolean not null default false,
  acceso_articulos boolean not null default false,
  acceso_compras boolean not null default false,
  acceso_gastos boolean not null default false,
  acceso_ventas boolean not null default false,
  created_at timestamptz not null default now()
);
alter table usuarios add column if not exists es_admin boolean not null default false;
alter table usuarios add column if not exists acceso_clientes boolean not null default false;
alter table usuarios add column if not exists acceso_articulos boolean not null default false;
alter table usuarios add column if not exists acceso_compras boolean not null default false;
alter table usuarios add column if not exists acceso_gastos boolean not null default false;
alter table usuarios add column if not exists acceso_ventas boolean not null default false;
alter table usuarios add column if not exists acceso_prospectos boolean not null default false;

-- Permiso especial (no es un módulo entero): habilita editar o eliminar
-- una factura de compra que ya está confirmada, algo que por defecto
-- solo puede hacer un administrador. Se guarda y se delega igual que los
-- accesos por módulo, desde la pantalla de Usuarios.
alter table usuarios add column if not exists permiso_editar_confirmadas boolean not null default false;

-- Antes de que existieran los permisos por módulo, cualquier usuario
-- cargado tenía acceso a todo. Para no dejar a nadie afuera de un día
-- para el otro, la primera vez que corre este bloque (todavía no hay
-- ningún administrador) promueve a administrador, con acceso total, a
-- todos los usuarios que ya estuvieran cargados en ese momento. Una vez
-- que existe al menos un administrador, no vuelve a tocar nada.
do $$
begin
  if not exists (select 1 from usuarios where es_admin = true) then
    update usuarios set
      es_admin = true,
      acceso_clientes = true,
      acceso_articulos = true,
      acceso_compras = true,
      acceso_gastos = true,
      acceso_ventas = true,
      acceso_prospectos = true;
  end if;
end $$;

create index if not exists idx_facturas_compra_items_factura on facturas_compra_items(factura_id);
create index if not exists idx_prospectos_activo on prospectos(activo);
create index if not exists idx_ventas_items_venta on ventas_items(venta_id);
create index if not exists idx_gastos_fecha on gastos(fecha);
create index if not exists idx_ventas_fecha on ventas(fecha);
