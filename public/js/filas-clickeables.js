// Hace que tocar/clickear en cualquier parte de una fila de una lista
// (ventas, clientes, artículos, visitas/prospectos) abra directo el
// detalle o perfil correspondiente — esas listas ya no tienen columna de
// "Ver"/"Editar"/"Eliminar" (quedó redundante: alcanza con tocar la fila
// o el nombre), y esas acciones viven adentro del perfil que se abre.
// Funciona igual en celular que en pantallas grandes.
(function () {
  document.addEventListener('click', function (e) {
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
