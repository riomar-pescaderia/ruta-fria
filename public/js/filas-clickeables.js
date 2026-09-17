// Hace que, en el celular, tocar en cualquier parte de una fila de una
// lista (ventas, clientes, artículos, visitas/prospectos) abra directo el
// detalle o perfil correspondiente — sin tener que acertarle al botón
// "Ver"/"Editar", que en esas pantallas angostas queda escondido (ver
// public/css/style.css, clase .col-acciones-lista) porque ya no hace
// falta: el perfil que se abre tiene sus propias acciones (editar,
// eliminar, etc.) adentro.
//
// En pantallas más anchas (donde SÍ se ven esos botones) no cambia nada:
// ahí se sigue usando "Ver"/"Editar" como siempre. Se decide en cada click
// para que también funcione bien si el usuario gira el celular o achica
// la ventana, no solo al cargar la página.
(function () {
  function esCelular() {
    return window.matchMedia('(max-width: 560px)').matches;
  }

  document.addEventListener('click', function (e) {
    if (!esCelular()) return;
    var fila = e.target.closest('tr[data-href]');
    if (!fila) return;
    // Si el toque fue sobre un link, botón, campo o form propio de la fila
    // (por ejemplo el selector de "Orden en listado PDF" en Artículos, o el
    // link del nombre en Historial de visitas) dejamos que haga lo suyo en
    // vez de pisarlo con la navegación al perfil.
    if (e.target.closest('a, button, input, select, textarea, label, form')) return;
    window.location.href = fila.dataset.href;
  });
})();
