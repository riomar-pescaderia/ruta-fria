// Envío de notificaciones push a la app de vendedores (Firebase Cloud
// Messaging), usadas únicamente para pedirle a un celular que reporte su
// ubicación en ese momento — no hay rastreo continuo, la app nunca manda
// nada si no se lo pedimos desde acá.
//
// Necesita la variable de entorno FIREBASE_SERVICE_ACCOUNT con el
// contenido completo (en una sola línea, como JSON) del archivo de
// credenciales de una cuenta de servicio de Firebase. Sin esa variable
// configurada, solicitarUbicacion() tira un error claro en vez de fallar
// de forma críptica — así el resto del sistema puede seguir funcionando
// aunque todavía no se haya conectado Firebase.
let appFirebase = null;
let intentoInicializar = false;

function obtenerApp() {
  if (appFirebase) return appFirebase;
  if (intentoInicializar) return null;
  intentoInicializar = true;

  const credencialesJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credencialesJson) return null;

  try {
    const admin = require('firebase-admin');
    const credenciales = JSON.parse(credencialesJson);
    appFirebase = admin.initializeApp({
      credential: admin.credential.cert(credenciales),
    });
    return appFirebase;
  } catch (err) {
    console.error('[ruta-fria] no se pudo inicializar Firebase:', err.message);
    return null;
  }
}

function configurado() {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

// Manda, a cada token FCM recibido, un mensaje "de datos" (sin texto
// visible: la app decide qué hacer al recibirlo, no aparece como una
// notificación con sonido) pidiendo que reporte la ubicación actual.
// Devuelve cuántos se mandaron bien y cuáles fallaron (por ejemplo, un
// token viejo de una app desinstalada).
async function solicitarUbicacion(tokensFcm) {
  if (!configurado()) {
    const error = new Error(
      'Falta configurar la variable de entorno FIREBASE_SERVICE_ACCOUNT en Render para poder mandar notificaciones push.'
    );
    error.sinConfigurar = true;
    throw error;
  }
  const app = obtenerApp();
  if (!app) {
    const error = new Error('No se pudo inicializar Firebase — revisá que FIREBASE_SERVICE_ACCOUNT tenga el JSON completo y válido.');
    throw error;
  }
  const admin = require('firebase-admin');

  const tokensValidos = (tokensFcm || []).filter(Boolean);
  const resultados = await Promise.allSettled(
    tokensValidos.map((token) =>
      admin.messaging().send({
        token,
        data: { tipo: 'solicitar_ubicacion' },
        android: { priority: 'high' },
      })
    )
  );

  const enviados = resultados.filter((r) => r.status === 'fulfilled').length;
  const fallidos = resultados.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message);
  return { enviados, fallidos };
}

module.exports = { solicitarUbicacion, configurado };
