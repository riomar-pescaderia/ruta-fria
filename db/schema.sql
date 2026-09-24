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

-- Categoría de gasto que provee este proveedor (ver lib/categoriasGasto.js)
-- — se usa para filtrar el desplegable de proveedores en Compras según la
-- categoría elegida. Null mientras no se categorice: un proveedor sin
-- categoría asignada sigue apareciendo para cualquier categoría, para no
-- romper facturas ya cargadas con proveedores todavía sin categorizar.
alter table proveedores add column if not exists categoria text;

-- Razón social y CUIT del proveedor — datos administrativos aparte del
-- "nombre" (el que se usa para mostrarlo en los desplegables y listados).
alter table proveedores add column if not exists razon_social text;
alter table proveedores add column if not exists cuit text;

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

-- Orden de aparición dentro del listado de precios en PDF (ver
-- routes/articulos.js y views/articulos/lista.ejs): 1, 2 o 3 para
-- destacar un artículo primero, segundo o tercero en ese orden; null para
-- los que no tienen prioridad asignada, que van al final ordenados por
-- nombre. No afecta en nada al resto del sistema, solo al PDF.
alter table articulos add column if not exists prioridad_listado integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_articulo_prioridad_listado'
  ) then
    alter table articulos
      add constraint chk_articulo_prioridad_listado
      check (prioridad_listado is null or prioridad_listado in (1, 2, 3));
  end if;
end $$;

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

-- Categoría del comprobante (ver lib/categoriasGasto.js) — "mercaderia"
-- es la única que arrastra artículos de stock y pisa costos; el resto
-- (servicios, insumos, alquileres, etc.) carga sus renglones a mano, sin
-- vínculo con el catálogo de artículos. Las facturas cargadas antes de
-- que existiera esta columna eran todas de mercadería, por eso el
-- default.
alter table facturas_compra add column if not exists categoria text not null default 'mercaderia';

-- Subtipo dentro de la categoría (ver lib/categoriasGasto.js), por ejemplo
-- "Electricidad" dentro de "Servicios" — opcional, para poder sacar
-- informes más finos. Las categorías que no tienen subtipos (Mercadería,
-- Inversión, Otros) quedan siempre en null.
alter table facturas_compra add column if not exists subtipo text;

-- "fecha" arrancó como solo día (date) porque el formulario de Compras
-- solo pedía una fecha, sin hora. Se pasa a timestamptz para que de acá
-- en adelante quede registrada también la hora en que se cargó cada
-- factura (ver lib/fechas.js) — las facturas ya cargadas quedan a la
-- medianoche de su mismo día, porque esa hora nunca se guardó y no hay
-- forma de reconstruirla.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'facturas_compra' and column_name = 'fecha' and data_type = 'date'
  ) then
    alter table facturas_compra alter column fecha type timestamptz using fecha::timestamptz;
    alter table facturas_compra alter column fecha set default now();
  end if;
end $$;

-- Para una factura que no es de mercadería, el renglón no tiene un
-- artículo real: "codigo_manual" y "descripcion" son lo que se tipeó a
-- mano en esos casos, y quedan null cuando el renglón sí es de un
-- artículo del catálogo (ahí manda articulo_id). El check de abajo
-- asegura que todo renglón tenga uno de los dos.
alter table facturas_compra_items add column if not exists codigo_manual text;
alter table facturas_compra_items add column if not exists descripcion text;
alter table facturas_compra_items alter column articulo_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_factura_item_articulo_o_descripcion'
  ) then
    alter table facturas_compra_items
      add constraint chk_factura_item_articulo_o_descripcion
      check (articulo_id is not null or descripcion is not null);
  end if;
end $$;

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

-- Misma migración que la de facturas_compra más arriba: de acá en
-- adelante una visita también registra la hora, no solo el día.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'prospectos_visitas' and column_name = 'fecha' and data_type = 'date'
  ) then
    alter table prospectos_visitas alter column fecha type timestamptz using fecha::timestamptz;
    alter table prospectos_visitas alter column fecha set default now();
  end if;
end $$;

-- Quién registró cada visita — hace falta para poder dejar que un
-- vendedor borre una visita que cargó él mismo, pero no las de otro
-- (ver /prospectos/:id/visitas/:visitaId/eliminar). "on delete set null"
-- en vez de "cascade": si se borra el usuario, la visita en sí sigue
-- siendo parte del historial, solo que sin dueño (a partir de ahí ya no
-- la puede borrar nadie salvo un administrador). Null en las visitas
-- cargadas antes de esta actualización, por la misma razón.
alter table prospectos_visitas add column if not exists usuario_id integer references usuarios(id) on delete set null;

-- Si el prospecto ya compró y está cargado en Clientes, se vincula acá —
-- así el mapa puede distinguir de un vistazo quién ya es cliente de quién
-- todavía es solo una visita. Null mientras siga siendo solo un prospecto.
-- Ya no se elige a mano desde el formulario del prospecto: se completa
-- solo (por CUIT/DNI o teléfono coincidente, ver lib/vinculacion.js) o
-- desde un botón de "Vincular" en el detalle del prospecto.
alter table prospectos add column if not exists cliente_id integer references clientes(id);

-- Arregla prospectos ya "eliminados" (inactivos) de antes de que borrar
-- un prospecto también soltara este vínculo: si quedaron con cliente_id
-- cargado, esa referencia fantasma podía bloquear para siempre el
-- borrado del cliente en Clientes, sin ninguna forma de arreglarlo desde
-- la interfaz. Es una limpieza de una sola vez — una vez que no quedan
-- casos así, no vuelve a tocar nada.
update prospectos set cliente_id = null where activo = false and cliente_id is not null;

-- CUIT/DNI del negocio, opcional mientras es solo un prospecto — sirve
-- como dato de referencia y, sobre todo, como la forma más confiable de
-- reconocerlo automáticamente si más adelante se carga como cliente.
alter table prospectos add column if not exists cuit_dni text;

-- Ciudad del prospecto, aparte de la dirección completa — así el listado
-- de "Historial visitas" puede ofrecer un filtro por ciudad sin tener que
-- adivinarla recortando el texto libre de "direccion". Se completa sola
-- cuando se busca la dirección en el mapa (Nominatim la devuelve como
-- parte del resultado, ver lib/geocode.js) — queda null en los prospectos
-- ya cargados hasta que se les vuelva a buscar la dirección una vez.
alter table prospectos add column if not exists ciudad text;

-- Un prospecto puede tener más de una persona de contacto (dueño,
-- encargado, etc.), cada una con su propio teléfono. Reemplaza a las
-- columnas sueltas "contacto"/"telefono" de prospectos, que quedan nada
-- más para no perder los datos ya cargados — la migración de abajo copia
-- ese contacto único como el primero de la lista la primera vez que corre.
create table if not exists prospectos_contactos (
  id serial primary key,
  prospecto_id integer not null references prospectos(id) on delete cascade,
  nombre text,
  telefono text,
  orden integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_prospectos_contactos_prospecto on prospectos_contactos(prospecto_id);

insert into prospectos_contactos (prospecto_id, nombre, telefono, orden)
select p.id, p.contacto, p.telefono, 0
from prospectos p
where (p.contacto is not null or p.telefono is not null)
  and not exists (select 1 from prospectos_contactos pc where pc.prospecto_id = p.id);

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

alter table ventas add column if not exists notas text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_venta_forma_pago'
  ) then
    alter table ventas
      add constraint chk_venta_forma_pago
      check (forma_pago in ('efectivo', 'transferencia', 'cuenta_corriente'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_venta_estado'
  ) then
    alter table ventas
      add constraint chk_venta_estado
      check (estado in ('emitido', 'entregado', 'cobrado'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_venta_origen'
  ) then
    alter table ventas
      add constraint chk_venta_origen
      check (origen in ('deposito', 'calle'));
  end if;
end $$;

-- Cómo se cobra realmente una venta — aparte de "forma_pago", que sigue
-- siendo un solo valor y define nada más qué lista de precios se sugiere
-- al cargar los renglones (ver el comentario arriba de routes/ventas.js).
-- Una venta puede cobrarse con más de un medio a la vez (por ejemplo,
-- parte en efectivo y el resto por transferencia, o parte en efectivo y
-- el resto a cuenta corriente) — cada fila de acá es un medio con su
-- monto, y entre todas tienen que sumar el total de la venta (se valida
-- en routes/ventas.js antes de guardar). Reemplaza por completo sus filas
-- cada vez que se guarda la venta, igual que ventas_items.
create table if not exists ventas_pagos (
  id serial primary key,
  venta_id integer not null references ventas(id) on delete cascade,
  medio_pago text not null,
  monto numeric not null,
  orden integer not null default 0
);
create index if not exists idx_ventas_pagos_venta on ventas_pagos(venta_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_venta_pago_medio'
  ) then
    alter table ventas_pagos
      add constraint chk_venta_pago_medio
      check (medio_pago in ('efectivo', 'transferencia', 'cuenta_corriente'));
  end if;
end $$;

-- Migración de una sola vez: a cada venta ya cargada (de antes de que
-- existiera esta tabla) se le arma un único medio de pago, con toda su
-- forma_pago y su total — así queda con el mismo resultado que tenía
-- hasta ahora, sin que el dueño tenga que volver a cargar nada. Corre
-- una sola vez porque después ya no encuentra la tabla vacía.
do $$
begin
  if not exists (select 1 from ventas_pagos limit 1) then
    insert into ventas_pagos (venta_id, medio_pago, monto, orden)
    select id, forma_pago, total, 0 from ventas;
  end if;
end $$;

-- Presupuestos: misma idea que una venta (cliente + renglones de
-- artículos + forma de pago), pero es solo una cotización para mostrarle
-- un precio al cliente — no genera ningún movimiento de stock ni de
-- cuenta corriente, y tiene su propia numeración (numero_presupuesto),
-- separada de la de ventas (numero_remito). Ver routes/presupuestos.js.
create table if not exists presupuestos (
  id serial primary key,
  numero_presupuesto serial,
  cliente_id integer not null references clientes(id),
  fecha timestamptz not null default now(),
  forma_pago text not null,
  notas text,
  total numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists presupuestos_items (
  id serial primary key,
  presupuesto_id integer not null references presupuestos(id) on delete cascade,
  articulo_id integer not null references articulos(id),
  cantidad numeric not null,
  precio_unitario numeric not null,
  subtotal numeric not null
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_presupuesto_forma_pago'
  ) then
    alter table presupuestos
      add constraint chk_presupuesto_forma_pago
      check (forma_pago in ('efectivo', 'transferencia', 'cuenta_corriente'));
  end if;
end $$;

create index if not exists idx_presupuestos_items_presupuesto on presupuestos_items(presupuesto_id);

-- Cuenta corriente de clientes. "recibos" son los cobros que se cargan a
-- mano (ver routes/cuentaCorriente.js); "cuenta_corriente_movimientos" es
-- el libro con un renglón por cada venta a cuenta corriente (debe, la
-- genera sola routes/ventas.js — ver lib/cuentaCorriente.js) y por cada
-- recibo (haber), más los ajustes manuales (por ejemplo el saldo inicial
-- de un cliente que ya tenía cuenta corriente antes de este sistema).
create table if not exists recibos (
  id serial primary key,
  numero_recibo serial,
  cliente_id integer not null references clientes(id),
  fecha date not null default current_date,
  monto numeric not null,
  medio_pago text not null default 'efectivo',  -- efectivo / transferencia / cheque / otro
  notas text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_recibo_medio_pago'
  ) then
    alter table recibos
      add constraint chk_recibo_medio_pago
      check (medio_pago in ('efectivo', 'transferencia', 'cheque', 'otro'));
  end if;
end $$;

-- Misma migración que la de facturas_compra: de acá en adelante un
-- recibo también registra la hora en que se cargó, no solo el día.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'recibos' and column_name = 'fecha' and data_type = 'date'
  ) then
    alter table recibos alter column fecha type timestamptz using fecha::timestamptz;
    alter table recibos alter column fecha set default now();
  end if;
end $$;

create table if not exists cuenta_corriente_movimientos (
  id serial primary key,
  cliente_id integer not null references clientes(id),
  fecha date not null default current_date,
  tipo text not null,  -- venta / recibo / ajuste
  venta_id integer references ventas(id) on delete cascade,
  recibo_id integer references recibos(id) on delete cascade,
  debe numeric not null default 0,
  haber numeric not null default 0,
  notas text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_movimiento_tipo'
  ) then
    alter table cuenta_corriente_movimientos
      add constraint chk_movimiento_tipo
      check (tipo in ('venta', 'recibo', 'ajuste'));
  end if;
end $$;

-- Misma migración: de acá en adelante un movimiento de cuenta corriente
-- (venta, recibo o ajuste) también registra la hora en que se cargó.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'cuenta_corriente_movimientos' and column_name = 'fecha' and data_type = 'date'
  ) then
    alter table cuenta_corriente_movimientos alter column fecha type timestamptz using fecha::timestamptz;
    alter table cuenta_corriente_movimientos alter column fecha set default now();
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_movimiento_debe_haber'
  ) then
    alter table cuenta_corriente_movimientos
      add constraint chk_movimiento_debe_haber
      check (debe >= 0 and haber >= 0 and not (debe > 0 and haber > 0));
  end if;
end $$;

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
  acceso_informes boolean not null default false,
  acceso_ventas boolean not null default false,
  created_at timestamptz not null default now()
);
alter table usuarios add column if not exists es_admin boolean not null default false;
alter table usuarios add column if not exists acceso_clientes boolean not null default false;
alter table usuarios add column if not exists acceso_articulos boolean not null default false;
alter table usuarios add column if not exists acceso_compras boolean not null default false;
-- "Gastos" pasó a llamarse "Informes" (la sección terminó mostrando
-- mucho más que solo gastos) — el permiso se renombra junto con la
-- sección, sin perder lo que ya tenía habilitado cada usuario.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'usuarios' and column_name = 'acceso_gastos'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'usuarios' and column_name = 'acceso_informes'
  ) then
    alter table usuarios rename column acceso_gastos to acceso_informes;
  end if;
end $$;
alter table usuarios add column if not exists acceso_informes boolean not null default false;
alter table usuarios add column if not exists acceso_ventas boolean not null default false;
alter table usuarios add column if not exists acceso_prospectos boolean not null default false;
alter table usuarios add column if not exists acceso_stock boolean not null default false;
alter table usuarios add column if not exists acceso_cuenta_corriente boolean not null default false;

-- Columna en desuso: el mapa fue una sección aparte con su propio
-- permiso y volvió a vivir adentro de Historial de visitas (mismo
-- permiso que "prospectos"). Se deja la columna sin tocar (no se
-- borra una columna existente sin necesidad) pero la app ya no la lee
-- ni la escribe.
alter table usuarios add column if not exists acceso_mapa boolean not null default false;

-- Permiso especial (no es un módulo entero): habilita editar o eliminar
-- una factura de compra que ya está confirmada, algo que por defecto
-- solo puede hacer un administrador. Se guarda y se delega igual que los
-- accesos por módulo, desde la pantalla de Usuarios.
alter table usuarios add column if not exists permiso_editar_confirmadas boolean not null default false;

-- Copia de la contraseña cifrada de forma reversible (no el hash de
-- bcrypt, que no se puede revertir), para que un administrador pueda
-- verla desde Usuarios si la necesita. Se guarda cifrada con AES-256-GCM
-- (ver lib/auth.js), nunca en texto plano. Los usuarios creados antes de
-- este cambio quedan con este campo vacío hasta que se les cambie la
-- contraseña una vez.
alter table usuarios add column if not exists password_visible text;

-- El login y el alta de usuarios no distinguen mayúsculas de minúsculas
-- en el nombre de usuario ("Juan" y "juan" son la misma cuenta). El
-- índice único evita que se puedan crear dos cuentas que solo difieran
-- en mayúsculas/minúsculas; si por algo ya existiera ese choque en datos
-- viejos, se salta la creación del índice en vez de romper el arranque
-- (la comparación case-insensitive en el código sigue funcionando igual).
do $$
begin
  if not exists (
    select 1 from (
      select lower(username) as u from usuarios group by lower(username) having count(*) > 1
    ) dup
  ) and not exists (
    select 1 from pg_indexes where indexname = 'usuarios_username_lower_idx'
  ) then
    create unique index usuarios_username_lower_idx on usuarios (lower(username));
  end if;
end $$;

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
      acceso_informes = true,
      acceso_ventas = true,
      acceso_prospectos = true,
      acceso_stock = true,
      acceso_cuenta_corriente = true;
  end if;
end $$;

-- Para poder reconocer un posible vínculo con un prospecto por domicilio
-- (además de por CUIT/DNI o teléfono, ver lib/vinculacion.js), el cliente
-- necesita quedar ubicado igual que un prospecto: geocodificado a lat/lng,
-- no solo con la dirección en texto libre.
alter table clientes add column if not exists lat numeric;
alter table clientes add column if not exists lng numeric;

-- Umbral opcional de stock bajo, por artículo (ver /stock) — null = sin
-- alerta configurada, solo se avisa cuando el stock llega a 0 o menos.
alter table articulos add column if not exists stock_minimo numeric;

-- Historial de movimientos de stock (ver lib/stock.js y routes/stock.js):
-- cada venta resta, cada compra de mercadería confirmada suma, y un
-- administrador puede ajustarlo a mano — cada uno de esos tres casos deja
-- un renglón acá, además de actualizar articulos.stock (el saldo
-- vigente). "cantidad" va con signo (positivo = entrada, negativo =
-- salida) y "stock_resultante" guarda cómo quedó el saldo justo después
-- de ese movimiento, para no tener que recalcularlo sumando todo el
-- historial cada vez que se muestra. Va después de "usuarios" en este
-- archivo porque referencia esa tabla, y las referencias necesitan que la
-- tabla ya exista en el momento de crear esta.
create table if not exists stock_movimientos (
  id serial primary key,
  articulo_id integer not null references articulos(id),
  tipo text not null,   -- venta / venta_eliminada / compra / compra_eliminada / ajuste / sincronizacion
  cantidad numeric not null,
  stock_resultante numeric not null,
  motivo text,                                                    -- libre, sobre todo para "ajuste"/"sincronizacion"
  referencia_venta_id integer references ventas(id) on delete set null,
  referencia_factura_id integer references facturas_compra(id) on delete set null,
  usuario_id integer references usuarios(id),
  fecha timestamptz not null default now()
);

-- Se recrea siempre (drop + add) en vez de "si no existe" porque la lista
-- de tipos permitidos cambió (se agregó "sincronizacion") y un check ya
-- creado con la lista vieja no se actualiza solo.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'chk_stock_movimiento_tipo'
  ) then
    alter table stock_movimientos drop constraint chk_stock_movimiento_tipo;
  end if;
  alter table stock_movimientos
    add constraint chk_stock_movimiento_tipo
    check (tipo in ('venta', 'venta_eliminada', 'compra', 'compra_eliminada', 'ajuste', 'sincronizacion'));
end $$;

-- Origen del stock: por defecto "automatico" (se mueve solo con ventas y
-- compras confirmadas, más el ajuste a mano de un administrador — el modo
-- pensado para cuando el depósito propio esté operativo). "planilla"
-- es el modo puente para mientras tanto: el stock de TODOS los artículos
-- sale únicamente de una hoja de cálculo externa (ver lib/stockPlanilla.js),
-- que se vuelve a leer cada vez que se abre /stock — en ese modo, ventas y
-- compras dejan de tocar articulos.stock. Tabla de una sola fila (id=1),
-- para poder cambiar el modo desde la propia pantalla de Stock sin tocar
-- código ni hacer un nuevo despliegue.
create table if not exists stock_config (
  id integer primary key default 1,
  modo text not null default 'automatico' check (modo in ('automatico', 'planilla')),
  planilla_url text,
  planilla_nombre text,
  ultima_sincronizacion timestamptz,
  ultimo_error text,
  constraint stock_config_singleton check (id = 1)
);

-- Arranca ya en modo "planilla", apuntando a la hoja real que se usa
-- mientras el depósito propio está en refacción — se puede cambiar de
-- modo o de link más adelante desde la propia pantalla de Stock.
insert into stock_config (id, modo, planilla_url, planilla_nombre) values (
  1, 'planilla',
  'https://docs.google.com/spreadsheets/d/1Bmyy7ZV2jf3fUjLBaXvoCQcIPa-G8KOTMrDAchfLFd0/export?format=csv&gid=1265317247',
  'Stock La Rioja 35'
)
on conflict (id) do nothing;

-- Impuestos y percepciones cargados a mano en una factura de compra (por
-- ejemplo, percepciones de IIBB que vienen sumadas al pie de la factura).
-- Se guardan aparte de los renglones de artículos porque no tienen que
-- impactar ni en el costo ni en el precio de ningún producto — solo suman
-- al total de la factura.
create table if not exists facturas_compra_impuestos (
  id serial primary key,
  factura_id integer not null references facturas_compra(id) on delete cascade,
  nombre text not null,
  monto numeric not null default 0
);
create index if not exists idx_facturas_compra_impuestos_factura on facturas_compra_impuestos(factura_id);

-- Flete de mercadería imputado a esta factura de compra: apunta a otra
-- factura ya cargada con categoría "flete_mercaderia". A partir de esto se
-- calcula el % de flete a prorratear entre los artículos de la factura
-- (ver routes/compras.js). Una misma factura de flete solo se puede
-- imputar a una factura de mercadería a la vez (se controla en el código,
-- no acá, para poder despejarla si hace falta recargar/corregir algo).
alter table facturas_compra add column if not exists flete_factura_id integer references facturas_compra(id) on delete set null;

-- Igual que estado_costo pero para el % de flete sugerido/aplicado a cada
-- artículo al confirmar una factura con flete imputado: 'aplicado',
-- 'no_aplicado' o 'sin_cambio'. Null si la factura no tiene flete imputado
-- o todavía no se confirmó.
alter table facturas_compra_items add column if not exists estado_flete text;

-- Ahora se puede imputar MÁS de una factura de flete a una misma factura
-- de mercadería (se suman los totales de flete para calcular el %) — esta
-- tabla reemplaza a la columna "flete_factura_id" de arriba, que solo
-- admitía una. Cada factura de flete sigue pudiendo imputarse a una sola
-- factura de mercadería a la vez (se controla en el código).
create table if not exists facturas_compra_fletes (
  factura_id integer not null references facturas_compra(id) on delete cascade,
  flete_factura_id integer not null references facturas_compra(id) on delete cascade,
  primary key (factura_id, flete_factura_id)
);
create index if not exists idx_facturas_compra_fletes_factura on facturas_compra_fletes(factura_id);
create index if not exists idx_facturas_compra_fletes_flete on facturas_compra_fletes(flete_factura_id);

-- Migra las imputaciones que ya existían en "flete_factura_id" (una por
-- factura) a la tabla nueva, y borra la columna vieja — se corre una sola
-- vez: después de la primera vez que corre, la columna ya no existe y el
-- "if exists" de abajo da falso para siempre.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'facturas_compra' and column_name = 'flete_factura_id'
  ) then
    insert into facturas_compra_fletes (factura_id, flete_factura_id)
    select id, flete_factura_id from facturas_compra where flete_factura_id is not null
    on conflict do nothing;
    alter table facturas_compra drop column flete_factura_id;
  end if;
end $$;

create index if not exists idx_facturas_compra_items_factura on facturas_compra_items(factura_id);
create index if not exists idx_prospectos_activo on prospectos(activo);
create index if not exists idx_ventas_items_venta on ventas_items(venta_id);
create index if not exists idx_gastos_fecha on gastos(fecha);
create index if not exists idx_facturas_compra_fecha on facturas_compra(fecha);
create index if not exists idx_ventas_fecha on ventas(fecha);
create index if not exists idx_ventas_cliente on ventas(cliente_id);
create index if not exists idx_movimientos_cliente on cuenta_corriente_movimientos(cliente_id);
create index if not exists idx_movimientos_venta on cuenta_corriente_movimientos(venta_id);
create index if not exists idx_movimientos_recibo on cuenta_corriente_movimientos(recibo_id);
create index if not exists idx_recibos_cliente on recibos(cliente_id);
create index if not exists idx_stock_movimientos_articulo on stock_movimientos (articulo_id, fecha desc);

-- App de vendedores (localización a pedido). Cada celular que instala la
-- app queda identificado con un token de sesión propio, generado al
-- loguearse (la app no usa cookies como la web) — se guarda solo un hash
-- del token, nunca el token en sí. Aparte se guarda el token de Firebase
-- Cloud Messaging de ese dispositivo, que es lo que permite mandarle una
-- notificación push pidiéndole la ubicación en cualquier momento.
create table if not exists app_dispositivos (
  id serial primary key,
  usuario_id integer not null references usuarios(id) on delete cascade,
  token_sesion_hash text not null unique,
  token_fcm text,
  modelo text,
  creado_en timestamptz not null default now(),
  ultimo_uso timestamptz not null default now()
);
create index if not exists idx_app_dispositivos_usuario on app_dispositivos(usuario_id);

-- Última ubicación conocida de cada usuario — se pisa con cada reporte
-- nuevo, no se guarda historial de recorrido (alcanza con saber dónde
-- está ahora). "solicitado_en" queda en null en cuanto llega una
-- ubicación nueva; si tiene fecha y no hay una ubicación más reciente
-- que ella, significa que se le pidió la ubicación y todavía no respondió.
create table if not exists ubicaciones_usuarios (
  usuario_id integer primary key references usuarios(id) on delete cascade,
  latitud double precision,
  longitud double precision,
  precision_metros double precision,
  actualizado_en timestamptz,
  solicitado_en timestamptz
);

-- Historial de recorrido: a diferencia de ubicaciones_usuarios (que solo
-- guarda la última posición conocida), acá queda un renglón por cada
-- punto que manda el celular mientras el vendedor está "en jornada"
-- (ver TrackingService.kt en la app) — es lo que permite dibujar la ruta
-- del día y calcular los km recorridos. No se borra nada automáticamente
-- (retención: para siempre, por decisión del negocio).
create table if not exists ubicaciones_historial (
  id bigserial primary key,
  usuario_id integer not null references usuarios(id) on delete cascade,
  latitud double precision not null,
  longitud double precision not null,
  precision_metros double precision,
  capturado_en timestamptz not null default now()
);
create index if not exists idx_ubicaciones_historial_usuario_fecha
  on ubicaciones_historial (usuario_id, capturado_en);

-- Horario laboral en el que la app tiene permitido mandar ubicación sola
-- (además de "Localizar ahora", que sigue funcionando a cualquier hora).
-- Estas dos claves de "config" fueron el horario único original (un solo
-- Desde/Hasta para los 7 días) — quedan solo como valor de arranque para
-- la migración de más abajo, ya no las lee ningún código nuevo.
insert into config (clave, valor) values
  ('tracking_hora_inicio_min', 480),
  ('tracking_hora_fin_min', 1140)
on conflict (clave) do nothing;

-- Horario de seguimiento, versión con franjas múltiples por día y
-- días independientes entre sí (reemplaza el horario único de arriba):
-- cada franja es "el vendedor X manda ubicación sola entre estos dos
-- horarios, este día de la semana". Un día sin ninguna franja cargada
-- significa seguimiento apagado ese día. dia_semana usa la misma
-- convención que extract(dow from ...) de Postgres y que
-- Calendar.DAY_OF_WEEK-1 del lado de la app: 0=domingo … 6=sábado.
create table if not exists tracking_horarios (
  id serial primary key,
  dia_semana integer not null check (dia_semana between 0 and 6),
  hora_inicio_min integer not null check (hora_inicio_min >= 0 and hora_inicio_min < 1440),
  hora_fin_min integer not null check (hora_fin_min > 0 and hora_fin_min <= 1440),
  check (hora_fin_min > hora_inicio_min)
);
create index if not exists idx_tracking_horarios_dia on tracking_horarios (dia_semana);

-- Migración de arranque, corre una sola vez (si la tabla nueva ya tiene
-- algo cargado, no hace nada — es seguro dejarla acá para siempre, igual
-- que el resto de este archivo): si había un horario único viejo
-- guardado en "config", se lo replica como la misma franja en los 7 días
-- para que ningún vendedor se quede sin seguimiento con esta actualización.
-- Si es una base nueva (sin esas claves tampoco), usa 08:00–19:00 todos
-- los días como valor de arranque razonable.
do $$
begin
  if not exists (select 1 from tracking_horarios) then
    insert into tracking_horarios (dia_semana, hora_inicio_min, hora_fin_min)
    select dia,
           coalesce((select valor from config where clave = 'tracking_hora_inicio_min'), 480)::integer,
           coalesce((select valor from config where clave = 'tracking_hora_fin_min'), 1140)::integer
    from generate_series(0, 6) as dia;
  end if;
end $$;

-- Cada cuánto manda su posición la app mientras está en una franja activa
-- (antes era un número fijo en el código de la app — TrackingService.kt —
-- y había que recompilarla para cambiarlo; ahora es editable desde
-- /vendedores/ubicacion/horario, reusando la tabla "config" porque es un
-- solo valor global, no algo por día). Minutos enteros.
insert into config (clave, valor) values ('tracking_intervalo_min', 1)
on conflict (clave) do nothing;
