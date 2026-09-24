// Sincroniza el movimiento de cuenta corriente que le corresponde a una
// venta. Se llama desde routes/ventas.js, dentro de la misma transacción,
// después de insertar o actualizar la venta (y sus medios de pago, en
// ventas_pagos). Ya no depende de si la venta ES "cuenta_corriente" —
// desde que una venta puede cobrarse con varios medios a la vez (parte
// efectivo, parte a cuenta corriente, por ejemplo), lo que suma deuda es
// puntualmente el monto que se haya cargado con ese medio, sea el total
// entero, una parte, o nada. Se borra el movimiento anterior y se vuelve
// a crear en vez de actualizarlo en el lugar, así cubre los mismos tres
// casos de antes con la misma lógica: un renglón nuevo, uno que cambió de
// importe/fecha/cliente, o uno que dejó de corresponder porque ya no
// queda nada de esa venta a cuenta corriente.
//
// Al borrar la venta el movimiento se borra solo, por el "on delete
// cascade" de cuenta_corriente_movimientos.venta_id — no hace falta
// llamar a esta función desde la ruta de eliminar.
async function sincronizarMovimientoVenta(client, venta) {
  await client.query('delete from cuenta_corriente_movimientos where venta_id = $1', [venta.id]);
  const montoCuentaCorriente = Number(venta.montoCuentaCorriente) || 0;
  if (montoCuentaCorriente > 0) {
    await client.query(
      `insert into cuenta_corriente_movimientos (cliente_id, fecha, tipo, venta_id, debe, notas)
       values ($1,$2,'venta',$3,$4,$5)`,
      [venta.cliente_id, venta.fecha, venta.id, montoCuentaCorriente, `Venta remito Nº ${venta.numero_remito}`]
    );
  }
}

module.exports = { sincronizarMovimientoVenta };
