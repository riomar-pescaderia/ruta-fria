// Sincroniza el movimiento de cuenta corriente que le corresponde a una
// venta. Se llama desde routes/ventas.js, dentro de la misma transacción,
// después de insertar o actualizar la venta. Solo las ventas con
// forma_pago = 'cuenta_corriente' generan un movimiento (debe) — las que
// se cobran en el momento (efectivo o transferencia) no suman deuda. Se
// borra el movimiento anterior y se vuelve a crear en vez de actualizarlo
// en el lugar, así cubre los tres casos con la misma lógica: un renglón
// nuevo, uno que cambió de importe/fecha/cliente, o uno que dejó de
// corresponder porque la venta pasó a otra forma de pago.
//
// Al borrar la venta el movimiento se borra solo, por el "on delete
// cascade" de cuenta_corriente_movimientos.venta_id — no hace falta
// llamar a esta función desde la ruta de eliminar.
async function sincronizarMovimientoVenta(client, venta) {
  await client.query('delete from cuenta_corriente_movimientos where venta_id = $1', [venta.id]);
  if (venta.forma_pago === 'cuenta_corriente') {
    await client.query(
      `insert into cuenta_corriente_movimientos (cliente_id, fecha, tipo, venta_id, debe, notas)
       values ($1,$2,'venta',$3,$4,$5)`,
      [venta.cliente_id, venta.fecha, venta.id, venta.total, `Venta remito Nº ${venta.numero_remito}`]
    );
  }
}

module.exports = { sincronizarMovimientoVenta };
