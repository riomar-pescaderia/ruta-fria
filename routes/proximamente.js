const express = require('express');

// Módulos todavía no implementados (Compras, Gastos, Ventas/Remitos).
// Devuelve una pantalla simple en vez de un 404, para poder navegar el
// esqueleto del sistema mientras se van sumando.
function proximamente(titulo, descripcion) {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.render('proximamente', { titulo, descripcion });
  });
  return router;
}

module.exports = proximamente;
