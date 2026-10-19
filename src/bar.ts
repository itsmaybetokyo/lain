import type { Brain } from "./brain.js"
import { C, paint, stripAnsi, truncateVisible } from "./theme.js"
import type { Entropy } from "./wired/entropy.js"

const miles = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))

/** Lo que la barra sabe de la Wired: badge cacheado y entradas sin subir. */
export interface WiredBar {
  /** "on" | "off" | "" mientras no haya dato todavía. */
  badge: "" | "on" | "off"
  entries: number
  /** Entradas tuyas sin empujar. */
  pend: number
}

export interface OpcionesBarra {
  wired: WiredBar
  brain?: Brain
  entropy: Entropy | null
  /** Texto del límite gratuito (vacío si todavía no hay dato). */
  limite?: string
  /** Ancho disponible: la barra se estira para llegar al borde. */
  cols: number
}

/** Qué significa cada tramo. La leyenda de /barra. */
export const AYUDA_BARRA: Array<[string, string]> = [
  ["the wired", "on si el repo responde · cuántas notas tiene · ?N son tuyas sin subir"],
  ["tokens", "los del turno: entrada→salida; si el proveedor no los informa, solo la salida estimada"],
  ["tok/s", "velocidad de los tokens de salida en este turno"],
  ["razón", "tokens que el modelo gastó pensando, aparte del texto que ves"],
  ["tiempo", "lo que duró el turno, desde el primer token hasta el último (o hasta ahora)"],
  ["generando", "generando mientras llega texto · listo cuando el turno terminó"],
  ["entropía", "reparto de la Wired entre nodos + frescura + volumen: 0% es un solo nodo, 100% muchas voces"],
  ["límite", "lo que queda del plan gratuito de opencode antes de reiniciarse"],
]

/**
 * Anchos mínimos (en caracteres visibles). Lo que sobra se reparte parejo, así
 * la barra llega al borde sin que los números corran a los demás tramos.
 */
const ANCHO = { wired: 30, tokens: 17, tps: 11, razon: 12, tiempo: 8, estado: 10, limite: 18 } as const

const SEP = " · "

const vis = (s: string): number => stripAnsi(s).length
const slot = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - vis(s)))

/** El tramo de la Wired, al estilo del relay: ▓▒░ the wired :: … */
function barraWired(w: WiredBar): string {
  const cabeza = paint(C.brmagenta, "▓▒░") + " " + paint(C.bold + C.brcyan, "the wired") + " "
  const cuerpo =
    w.badge === "on"
      ? paint(C.gray, ":: ") + paint(C.brgreen, "on") + paint(C.gray, ` · ${miles(w.entries)}`)
      : w.badge === "off"
        ? paint(C.gray, ":: ") + paint(C.brred, "sin conexión")
        : paint(C.gray, ":: buscando…")
  return cabeza + cuerpo + (w.pend > 0 ? paint(C.bryellow, ` ?${miles(w.pend)}`) : "")
}

function entropyColor(e: Entropy): string {
  if (e.value < 0.35) return C.dim
  if (e.value < 0.6) return C.brcyan
  return C.brmagenta
}

/** Entropía global de la Wired, con su barrita. */
function barraEntropia(e: Entropy | null): string {
  if (!e) return paint(C.dim, "entropía sin señal")
  return paint(C.dim, "entropía ") + paint(entropyColor(e), `${e.bar} ${String(e.pct).padStart(3)}%`)
}

/** La barra de abajo entera: the wired · tokens · velocidad · entropía al borde. */
export function barraDeAbajo(o: OpcionesBarra): string {
  const m = o.brain?.metrics()
  const hubo = !!m && (m.chars > 0 || m.tokIn > 0 || m.tokOut > 0)
  const tok = !hubo
    ? paint(C.brcyan, "0")
    : m!.tokIn > 0
      ? paint(C.brcyan, `${miles(m!.tokIn)}→${miles(m!.tokOut)}`)
      : paint(C.brcyan, `${miles(m!.tokOut)} salida`)

  const fijos: Array<{ clave: string; texto: string; ancho: number }> = [
    { clave: "the wired", texto: barraWired(o.wired), ancho: ANCHO.wired },
    { clave: "tokens", texto: paint(C.dim, "tokens ") + tok, ancho: ANCHO.tokens },
    {
      clave: "tok/s",
      texto: hubo && m!.tps > 0 ? paint(C.brgreen, `${m!.tps.toFixed(1)} tok/s`) : "",
      ancho: ANCHO.tps,
    },
    {
      clave: "razón",
      texto: hubo && m!.tokReason > 0 ? paint(C.dim, `razón ${miles(m!.tokReason)}`) : "",
      ancho: ANCHO.razon,
    },
    {
      clave: "tiempo",
      texto: hubo ? paint(C.dim, m!.live ? `${Math.round(m!.ms / 1000)}s` : `${(m!.ms / 1000).toFixed(1)} s`) : "",
      ancho: ANCHO.tiempo,
    },
    {
      clave: "generando",
      texto: m?.live ? paint(C.brcyan, "generando") : hubo ? paint(C.dim, "listo") : "",
      ancho: ANCHO.estado,
    },
    {
      clave: "límite",
      texto: o.limite?.trim() ? paint(C.bryellow, `límite en ${o.limite.trim()}`) : "",
      ancho: ANCHO.limite,
    },
  ]

  // La entropía se reserva primero: si la terminal es angosta, se achican (o se
  // sueltan) los demás tramos, pero su porcentaje se ve siempre.
  const cols = Number.isFinite(o.cols) ? Math.max(20, Math.floor(o.cols)) : 120
  const anchoMax = Math.max(10, cols - 1)
  const entropia = barraEntropia(o.entropy)
  const entW = vis(entropia)

  // De menor a mayor importancia: se van soltando si no hay lugar.
  const descarte = ["límite", "razón", "tiempo", "tok/s", "generando"]
  let activos = fijos.slice()
  const mide = (ts: typeof fijos): number =>
    ts.reduce((n, t) => n + Math.max(1, vis(t.texto)), 0) + SEP.length * ts.length + entW
  for (const clave of descarte) {
    if (mide(activos) <= anchoMax) break
    activos = activos.filter((t) => t.clave !== clave)
  }

  const n = Math.max(1, activos.length)
  const pisos = activos.map((t) => Math.max(1, vis(t.texto)))
  const bases = activos.map((t) => Math.max(t.ancho, vis(t.texto)))
  let libre = Math.max(0, anchoMax - entW - SEP.length * n)

  const anchos = pisos.slice()
  let queda = libre - anchos.reduce((a, b) => a + b, 0)
  if (queda < 0) {
    // Ni con el contenido entra: se recorta el relleno hasta dejarlo en 1.
    while (queda < 0) {
      let i = 0
      for (let j = 1; j < n; j++) if (anchos[j]! > anchos[i]!) i = j
      if (anchos[i]! <= 1) break
      anchos[i]!--
      queda++
    }
  } else {
    // Primero cada tramo crece hasta su ancho de siempre…
    let movido = true
    while (queda > 0 && movido) {
      movido = false
      for (let i = 0; i < n && queda > 0; i++) {
        if (anchos[i]! < bases[i]!) {
          anchos[i]!++
          queda--
          movido = true
        }
      }
    }
    // …y lo que todavía sobra se reparte parejo.
    for (let i = 0; queda > 0; i = (i + 1) % n) {
      anchos[i]!++
      queda--
    }
  }

  let texto = ""
  activos.forEach((t, i) => {
    if (i) texto += paint(C.dim, SEP)
    const w = Math.max(0, anchos[i] ?? 0)
    texto += slot(truncateVisible(t.texto, w), w)
  })
  texto += paint(C.dim, SEP)
  const hueco = Math.max(0, anchoMax - vis(texto) - entW)
  return texto + " ".repeat(hueco) + entropia
}
