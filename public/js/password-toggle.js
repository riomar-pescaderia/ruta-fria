// Agrega un botón de "ojito" a todos los campos de contraseña de la
// página para poder mostrar/ocultar lo que se escribió (o, en la lista
// de usuarios, lo que ya está guardado). No depende de ninguna librería.
(function () {
  function ojoAbierto() {
    return '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9Z"/><circle cx="9" cy="9" r="2.3"/></svg>';
  }

  function ojoCerrado() {
    return '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l14 14"/><path d="M7.5 4.2C8 4.07 8.5 4 9 4c4.5 0 7.5 5 7.5 5a13.7 13.7 0 0 1-2.4 3.1M5.2 5.6C3.1 6.9 1.5 9 1.5 9s3 5 7.5 5c1 0 1.9-.2 2.7-.5"/><path d="M7.1 7.1a2.3 2.3 0 0 0 3.2 3.2"/></svg>';
  }

  function agregarOjito(input) {
    if (input.dataset.toggleAplicado) return;
    input.dataset.toggleAplicado = '1';

    var wrapper = document.createElement('div');
    wrapper.className = 'campo-password-wrapper';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    var boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'toggle-password';
    boton.setAttribute('aria-label', 'Mostrar contraseña');
    boton.innerHTML = ojoAbierto();
    wrapper.appendChild(boton);

    boton.addEventListener('click', function () {
      var oculto = input.type === 'password';
      input.type = oculto ? 'text' : 'password';
      boton.innerHTML = oculto ? ojoCerrado() : ojoAbierto();
      boton.setAttribute('aria-label', oculto ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
  }

  document.querySelectorAll('input[type=password]').forEach(agregarOjito);
})();
