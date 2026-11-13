/**
 * El planeta de la Wired: una esfera sombreada en ASCII que gira, con las
 * mismas filas y columnas que el retrato de Lain, para que el panel no se mueva
 * cuando aparece ni cuando se va.
 */

/** Rampa de brillo: de vacío a lleno. */
const RAMP = " .·:-=+*#%@";

/** Continentes de mentira: manchas suaves sobre la esfera (lon/lat en radianes). */
const MANCHAS = [
  { lon: 0.35, lat: 0.42, sx: 0.5, sy: 0.42 }, // África y Europa
  { lon: 1.55, lat: 0.72, sx: 0.62, sy: 0.38 }, // Asia
  { lon: -1.85, lat: 0.15, sx: 0.42, sy: 0.62 }, // América
  { lon: 2.25, lat: -0.52, sx: 0.3, sy: 0.22 }, // Australia
  { lon: -0.7, lat: 1.15, sx: 0.35, sy: 0.18 }, // Groenlandia
] as const;

/** Cuánto se parece ese punto del globo a tierra firme (0 = mar, 1 = tierra). */
function tierra(lon: number, lat: number): number {
  // El sur es todo hielo.
  if (lat < -1.1) return 1;
  let v = 0;
  for (const m of MANCHAS) {
    let dl = lon - m.lon;
    // La longitud da la vuelta: -π y π son el mismo meridiano.
    while (dl > Math.PI) dl -= Math.PI * 2;
    while (dl < -Math.PI) dl += Math.PI * 2;
    v += Math.exp(-((dl / m.sx) ** 2) - (((lat - m.lat) / m.sy) ** 2));
  }
  // Costas irregulares: sin esto quedan manchas perfectas de gelatina.
  const ruido = Math.sin(lon * 4.7 + lat * 3.1) * Math.cos(lon * 2.3 - lat * 5.7);
  return Math.max(0, Math.min(1, v + 0.14 * ruido));
}

/**
 * Alto/ancho de una celda de terminal. La celda no es cuadrada: en esta fuente
 * mide 11 x 28 px (ratio 2.55). Si la esfera no se dibuja con esta proporción
 * sale ovalada (estirada a lo alto). Se puede afinar sin recompilar:
 * LAIN_GLOBE_ASPECT=2.4.
 */
const ASPECTO = (() => {
  const v = Number(process.env.LAIN_GLOBE_ASPECT ?? "")
  return Number.isFinite(v) && v > 1 ? v : 2.55;
})();

/** La proporción con la que se dibuja el planeta (para las pruebas). */
export const ASPECTO_CELDA = ASPECTO;

/**
 * Fotograma del planeta: `rows` filas de `cols` celdas. `giro` avanza con el
 * tiempo; cada unidad son ~16° de rotación.
 */
export function globeRows(rows: number, cols: number, giro: number): string[] {
  // La esfera se dibuja con la proporción de la celda y con margen, así queda
  // redonda y flota: filas en blanco arriba y abajo, y aire a los costados.
  const dispX = Math.max(3, cols - (cols > 8 ? 2 : 0));
  const dispY = Math.max(3, rows - (rows > 6 ? 2 : 0));
  let alto = dispY;
  let ancho = Math.round(alto * ASPECTO);
  if (ancho > dispX) {
    // El panel es más alto que ancho: manda el ancho y se recorta el alto.
    ancho = dispX;
    alto = Math.max(3, Math.round(ancho / ASPECTO));
  }
  const radioX = ancho / 2;
  const radioY = alto / 2;
  const out: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let linea = "";
    for (let cx = 0; cx < cols; cx++) {
      // Centro de la celda, en coordenadas de esfera (centrada en el panel).
      const x = (cx + 0.5 - cols / 2) / radioX;
      const y = (cy + 0.5 - rows / 2) / radioY;
      const r2 = x * x + y * y;
      if (r2 > 1) {
        linea += " ";
        continue;
      }
      const z = Math.sqrt(1 - r2);
      const lon = Math.atan2(x, z) + giro;
      // Arriba es el norte: el sur (la Antártida) queda abajo.
      const lat = Math.asin(Math.max(-1, Math.min(1, -y)));
      // Luz desde arriba a la izquierda y un poco de frente.
      const luz = 0.3 + 0.7 * Math.max(0, -0.42 * x - 0.5 * y + 0.76 * z);
      // El mar queda oscuro; la tierra, bien clara; la noche, apagada.
      const brillo = Math.min(1, luz * (0.45 + 0.85 * tierra(lon, lat)));
      // El limbo se marca para que la esfera no se deshilache.
      const borde = r2 > 0.94 ? Math.max(brillo, 0.5) : brillo;
      linea += RAMP[Math.min(RAMP.length - 1, Math.floor(borde * RAMP.length))]!;
    }
    out.push(linea);
  }
  return out;
}
