import { C, paint, sliceVisible, stripAnsi } from "./theme.js"

/** Una notificación de la Wired apilada bajo el retrato. */
export interface Aviso {
  titulo: string
  detalle: string
  quien: string[]
  cuando: number
  /** Si ya quedó en tu vault. */
  bajado: boolean
}

/** Tope de avisos guardados: cuando se llena, cae el más viejo. */
export const AVISOS_MAX = 12

/** Cuánto tarda el aviso nuevo en escribirse entero, carácter por carácter. */
const AVISO_ANIM_MS = 1700
let animStart = 0

/** Marca el momento en que llegó un aviso nuevo: dispara la animación. */
export function animarAviso(ahora = Date.now()): void {
  animStart = ahora
}

/** Deja el bloque asentado (sin animación). */
export function quietarAnim(): void {
  animStart = 0
}

/** 0 → recién llegó · 1 → ya escrito entero. */
export function avisoPhase(ahora = Date.now()): number {
  if (!animStart) return 1
  const p = (ahora - animStart) / AVISO_ANIM_MS
  return p >= 1 ? 1 : p
}

/** Parpadeo lento del marcador y del cursor mientras se escribe. */
function pulso(ahora: number): boolean {
  return Math.floor(ahora / 180) % 2 === 0
}

const hhmm = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Una notificación bajo el retrato, al estilo de lain (hasta 3 líneas). */
export function avisoLinesOne(a: Aviso): string[] {
  const out = [
    "  " + paint(C.brmagenta, "▓▒░") + " " + paint(C.bold + C.brcyan, "the wired") + " " + paint(C.gray, `:: ${a.titulo}`),
  ]
  const quien = a.quien.length
    ? a.quien.length <= 2
      ? a.quien.join(", ")
      : `${a.quien.slice(0, 2).join(", ")} +${a.quien.length - 2}`
    : ""
  const detalle = [a.detalle, quien ? `de ${quien}` : ""].filter(Boolean).join(" · ")
  if (detalle) out.push("    " + paint(C.brcyan, detalle))
  const pie = [hhmm(a.cuando), a.bajado ? "ya en tu vault" : ""].filter(Boolean).join(" · ")
  if (pie) out.push("    " + paint(C.dim, pie))
  return out
}

/** Deja ver solo los primeros `n` caracteres del bloque, línea por línea. */
function revela(ls: string[], n: number, cursor: boolean): string[] {
  const out: string[] = []
  let queda = n
  for (const l of ls) {
    const vis = stripAnsi(l).length
    if (queda <= 0) {
      out.push("") // todavía no llegó a esta línea: mantiene la altura
      continue
    }
    if (queda >= vis) {
      out.push(l)
      queda -= vis
      continue
    }
    out.push(sliceVisible(l, queda) + (cursor ? paint(C.brmagenta, "▌") : ""))
    queda = 0
  }
  return out
}

/** El aviso más nuevo: barra a la izquierda y texto que se escribe solo. */
function avisoNuevo(a: Aviso, fase: number, animando: boolean, ahora: number): string[] {
  const ls = avisoLinesOne(a)
  const cuerpo = [ls[0]!.slice(2), ...ls.slice(1)] // sin la sangría: la pone la barra
  const marca = paint(animando && pulso(ahora) ? C.brcyan : C.brmagenta, "▌")
  if (!animando) return [marca + " " + cuerpo[0]!, ...cuerpo.slice(1)]
  const total = cuerpo.reduce((n, l) => n + stripAnsi(l).length, 0)
  const revelado = revela(cuerpo, Math.min(total, Math.floor(fase * total)), pulso(ahora))
  return [marca + " " + revelado[0]!, ...revelado.slice(1)]
}

/**
 * Notificaciones apiladas (la más nueva arriba) que entran en `maxRows` filas.
 * Solo se muestran avisos enteros: así no queda uno cortado a la mitad.
 * El más nuevo se escribe carácter por carácter; los viejos ya están quietos.
 */
export function avisoLines(lista: Aviso[], maxRows = Infinity, ahora = Date.now()): string[] {
  const fase = avisoPhase(ahora)
  const animando = fase < 1
  const out: string[] = []
  for (let idx = 0; idx < lista.length; idx++) {
    const a = lista[idx]!
    const ls = idx === 0 ? avisoNuevo(a, fase, animando, ahora) : avisoLinesOne(a)
    const sep = out.length ? 1 : 0 // blanco entre avisos (no antes del primero)
    if (out.length + sep + ls.length > maxRows) break
    if (sep) out.push("")
    out.push(...ls)
  }
  // Un blanco que lo separe del retrato, si todavía sobra espacio.
  if (out.length && out.length < maxRows) out.unshift("")
  return out
}
