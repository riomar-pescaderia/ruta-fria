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

-- Acceso al módulo "Mapa" (antes vivía adentro de Historial de visitas,
-- ahora es una sección aparte con su propio permiso).
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
