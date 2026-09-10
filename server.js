require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./db/pool');

const clientesRouter = require('./routes/clientes');
const articulosRouter = require('./routes/articulos');
const proximamente = require('./routes/proximamente');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// se pasa a todas las vistas, para resaltar el link activo en la navegación
app.use((req, res, next) => {
  res.locals.path = req.path;
  next();
});

app.get('/', (req, res) => res.redirect('/clientes'));

app.use('/clientes', clientesRouter);
app.use('/articulos', articulosRouter);
app.use('/compras', proximamente('Compras', 'Cargar facturas de proveedores y que el costo de cada artículo se actualice solo.'));
app.use('/gastos', proximamente('Gastos generales', 'Sueldos, alquiler, insumos y demás gastos de la operación, con un panel de total por tipo.'));
app.use('/ventas', proximamente('Venta / remito', 'Cargar una venta, elegir forma de pago y generar el remito en PDF.'));

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
