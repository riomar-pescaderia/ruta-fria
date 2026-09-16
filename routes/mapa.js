// Mapa de visitas — antes vivía adentro de Historial de visitas, ahora es
// una sección aparte (con su propio permiso, acceso_mapa) para no mezclar
// "gestionar la lista de prospectos" con "ver dónde están todos".
const express = require('express');
const router = express.Router();
const { listarConVisitas } = require('../lib/prospectosCompartido');

router.get('/', async (req, res, next) => {
  try {
    const prospectos = await listarConVisitas();
    res.render('mapa/index', { prospectos });
  } catch (err) { next(err); }
});

module.exports = router;
