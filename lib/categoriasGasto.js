// Categorías para clasificar en qué se gasta la plata del negocio — se
// usan tanto para el "tipo de comprobante" al cargar una factura en
// Compras como (más adelante) para el módulo de Gastos generales, así los
// dos hablan el mismo idioma y se pueden cruzar en un informe.
//
// Están pensadas siguiendo la práctica contable habitual de separar
// "costo de mercadería vendida" (lo que se compra para revender) del
// resto de los gastos operativos, administrativos y financieros del
// negocio — con subtipos para poder después sacar informes más finos
// (por ejemplo, cuánto se gastó en electricidad en el año).
//
// "mercaderia" es la única categoría que arrastra artículos de stock y
// pisa costos — todas las demás cargan sus renglones a mano (código y
// descripción libres, sin vínculo con el catálogo de artículos).
const CATEGORIAS_GASTO = [
  {
    clave: 'mercaderia',
    etiqueta: 'Mercadería',
    descripcion: 'Pescado y productos que se compran para revender — la única categoría que actualiza costos de artículos.',
    subtipos: [],
  },
  {
    clave: 'insumos',
    etiqueta: 'Insumos',
    descripcion: 'Materiales de uso operativo que no se revenden.',
    subtipos: ['Packaging y embalaje', 'Limpieza e higiene', 'Librería y oficina', 'Indumentaria y seguridad (EPP)', 'Otros insumos'],
  },
  {
    clave: 'servicios',
    etiqueta: 'Servicios',
    descripcion: 'Servicios contratados, recurrentes u ocasionales.',
    subtipos: ['Electricidad', 'Gas', 'Agua', 'Internet y telefonía', 'Fletes y logística tercerizada', 'Software y sistemas', 'Seguridad y monitoreo', 'Otros servicios'],
  },
  {
    clave: 'sueldos',
    etiqueta: 'Sueldos y cargas sociales',
    descripcion: 'Personal en relación de dependencia y sus cargas.',
    subtipos: ['Sueldos', 'Cargas sociales y aportes', 'Aguinaldo', 'ART', 'Honorarios de personal tercerizado'],
  },
  {
    clave: 'alquileres',
    etiqueta: 'Alquileres',
    descripcion: 'Alquiler de inmuebles, vehículos o equipos.',
    subtipos: ['Depósito o local', 'Vehículos y equipos'],
  },
  {
    clave: 'impuestos',
    etiqueta: 'Impuestos y tasas',
    descripcion: 'Obligaciones fiscales y municipales.',
    subtipos: ['IIBB', 'Monotributo / Ganancias', 'Tasas municipales', 'Impuesto a los sellos', 'Otros impuestos'],
  },
  {
    clave: 'mantenimiento',
    etiqueta: 'Mantenimiento y reparaciones',
    descripcion: 'Arreglos y mantenimiento preventivo de bienes existentes.',
    subtipos: ['Vehículos (flota de reparto)', 'Cámaras frigoríficas y freezers', 'Depósito / edificio', 'Maquinaria y equipos'],
  },
  {
    clave: 'combustible',
    etiqueta: 'Combustible y viáticos',
    descripcion: 'Gastos de movilidad del reparto y las visitas.',
    subtipos: ['Combustible', 'Peajes', 'Viáticos de choferes/preventistas'],
  },
  {
    clave: 'publicidad',
    etiqueta: 'Publicidad y marketing',
    descripcion: 'Difusión y promoción del negocio.',
    subtipos: ['Redes sociales y diseño', 'Cartelería', 'Promociones'],
  },
  {
    clave: 'mobiliario',
    etiqueta: 'Mobiliario y equipamiento',
    descripcion: 'Bienes de uso: no se consumen, quedan como equipamiento del negocio.',
    subtipos: ['Mobiliario', 'Equipos de frío', 'Herramientas', 'Tecnología (PC, impresoras)'],
  },
  {
    clave: 'seguros',
    etiqueta: 'Seguros',
    descripcion: 'Pólizas sobre bienes o personas del negocio.',
    subtipos: ['Flota', 'Depósito y mercadería', 'Otros seguros'],
  },
  {
    clave: 'financieros',
    etiqueta: 'Gastos financieros y bancarios',
    descripcion: 'Costo de usar bancos, tarjetas o financiación.',
    subtipos: ['Comisiones bancarias', 'Intereses', 'Gastos de tarjeta'],
  },
  {
    clave: 'inversion',
    etiqueta: 'Inversión / bienes de uso',
    descripcion: 'Compras grandes y poco frecuentes que no son gasto corriente (una camioneta, una cámara de frío nueva).',
    subtipos: [],
  },
  {
    clave: 'otros',
    etiqueta: 'Otros',
    descripcion: 'Lo que no encaja en ninguna categoría anterior.',
    subtipos: [],
  },
];

function categoriaPorClave(clave) {
  return CATEGORIAS_GASTO.find((c) => c.clave === clave) || null;
}

function esClaveValida(clave) {
  return CATEGORIAS_GASTO.some((c) => c.clave === clave);
}

module.exports = { CATEGORIAS_GASTO, categoriaPorClave, esClaveValida };
