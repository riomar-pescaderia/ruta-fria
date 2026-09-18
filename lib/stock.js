// Movimientos de stock: cada venta, cada compra de mercadería confirmada
// y cada ajuste a mano de un administrador pasan por esta única función,
// que hace dos cosas siempre juntas, dentro de la misma transacción que
// ya esté abierta en quien la llama:
//   1) actualiza articulos.stock (el saldo vigente) sumando "cantidad"
//      (positiva = entrada, negativa = salida) — coalesce(stock, 0) para
//      que un artículo que nunca tuvo movimientos (stock en null) arranque
//      de 0 en vez de romper la cuenta;
//   2) deja un renglón en stock_movimientos con cómo quedó el saldo justo
//      después, para tener el historial sin recalcular nada.
//
// "client" tiene que ser una conexión con una transacción ya abierta
// (BEGIN) por quien llama — así el movimiento de stock se confirma o se
// revierte junto con el resto de la operación (la venta, la factura, etc).
async function registrarMovimiento(client, { articuloId, tipo, cantidad, motivo, usuarioId, ventaId, facturaId }) {
  const { rows } = await client.query(
    'update articulos set stock = coalesce(stock, 0) + $1 where id = $2 returning stock',
    [cantidad, articuloId]
  );
  const stockResultante = rows[0] ? rows[0].stock : cantidad;
  await client.query(
    `insert into stock_movimientos
      (articulo_id, tipo, cantidad, stock_resultante, motivo, referencia_venta_id, referencia_factura_id, usuario_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [articuloId, tipo, cantidad, stockResultante, motivo || null, ventaId || null, facturaId || null, usuarioId || null]
  );
  return stockResultante;
}

module.exports = { registrarMovimiento };
