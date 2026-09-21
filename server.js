require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db/pool');
const { requireAuth, refrescarSesion, requireAdmin, requireAcceso } = require('./lib/auth');

const clientesRouter = require('./routes/clientes');
const articulosRouter = require('./routes/articulos');
const usuariosRouter = require('./routes/usuarios');
const authRouter = require('./routes/auth');
const comprasRouter = require('./routes/compras');
const proveedoresRouter = require('./routes/proveedores');
const prospectosRouter = require('./routes/prospectos');
const ventasRouter = require('./routes/ventas');
const cuentaCorrienteRouter = require('./routes/cuentaCorriente');
const stockRouter = require('./routes/stock');
const informesRouter = require('./routes/informes');
const appApiRouter = require('./routes/appApi');
const vendedoresUbicacionRouter = require('./routes/vendedoresUbicacion');

const app = express();

// Render hace de proxy TLS delante del servicio — sin esto, la cookie de
// sesión "secure" nunca se marcaría como enviada por HTTPS.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'ruta-fria-cambiar-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días — así no hay que volver a loguearse todo el tiempo
    secure: !!process.env.RENDER,
    sameSite: 'lax',
  },
}));

// se pasa a todas las vistas, para resaltar el link activo en la navegación
// y mostrar quién está logueado
const { formatearFecha, formatearFechaHora } = require('./lib/fechas');
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.usuario = req.session.usuario || null;
  // Disponibles en cualquier vista para mostrar una fecha guardada con
  // su hora, siempre en hora de Argentina (ver lib/fechas.js).
  res.locals.formatearFecha = formatearFecha;
  res.locals.formatearFechaHora = formatearFechaHora;
  next();
});

// /login, /logout y /setup quedan siempre accesibles, sin login
app.use('/', authRouter);

// La API que usa la app Android de los vendedores queda siempre
// accesible, sin la sesión con cookie que usa la web — se autentica sola
// con el token que devuelve /api/app/login (ver routes/appApi.js).
app.use('/api/app', appApiRouter);

// todo lo que se registre de acá para abajo queda protegido — primero
// hay que estar logueado, y después se refresca el usuario de la sesión
// contra la base en cada pedido, para que un cambio de permisos hecho
// por un administrador tenga efecto ya mismo, sin desloguear a nadie
app.use(requireAuth);
app.use(refrescarSesion);

app.get('/', (req, res) => res.redirect('/clientes'));

app.use('/clientes', requireAcceso('clientes'), clientesRouter);
app.use('/articulos', requireAcceso('articulos'), articulosRouter);
app.use('/usuarios', requireAdmin, usuariosRouter);
app.use('/vendedores/ubicacion', requireAdmin, vendedoresUbicacionRouter);
app.use('/compras', requireAcceso('compras'), comprasRouter);
// Proveedores tiene su propia sección en el menú (entre Compras e Informes),
// separada de Compras, pero usa el mismo permiso de acceso ("compras") ya
// que conceptualmente sigue siendo parte de esa gestión.
app.use('/proveedores', requireAcceso('compras'), proveedoresRouter);
app.use('/prospectos', requireAcceso('prospectos'), prospectosRouter);
app.use('/informes', requireAcceso('informes'), informesRouter);
app.use('/ventas', requireAcceso('ventas'), ventasRouter);
app.use('/cuenta-corriente', requireAcceso('cuenta_corriente'), cuentaCorrienteRouter);
app.use('/stock', requireAcceso('stock'), stockRouter);

app.use((req, res) => res.status(404).render('404'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Ocurrió un error: ' + err.message);
});

const port = process.env.PORT || 3000;

// aplica el esquema al arrancar — usa "if not exists" en todas las tablas,
// así es seguro correrlo cada vez que el servicio se reinicia o redeploya.
async function iniciar() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('[ruta-fria] esquema de base de datos verificado.');
  } catch (err) {
    console.error('[ruta-fria] no se pudo aplicar el esquema al arrancar:', err.message);
  }
  app.listen(port, () => console.log(`[ruta-fria] escuchando en el puerto ${port}`));
}

iniciar();
