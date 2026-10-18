import type { Brain } from "./brain.js"
import { C, paint } from "./theme.js"
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

/** El tramo de la Wired, al estilo del relay: ▓▒░ the wired :: … */
export function barraWired(w: WiredBar): string {
  const cabeza = paint(C.brmagenta, "▓▒░") + " " + paint(C.bold + C.brcyan, "the wired") + " "
  const cuerpo =
    w.badge === "on"
      ? paint(C.gray, ":: ") + paint(C.brgreen, "on") + paint(C.gray, ` · ${w.entries}`)
      : w.badge === "off"
        ? paint(C.gray, ":: ") + paint(C.brred, "sin conexión")
        : paint(C.gray, ":: buscando…")
  return cabeza + cuerpo + (w.pend > 0 ? paint(C.bryellow, ` ?${w.pend}`) : "")
}

/** Tokens del turno y a qué velocidad salen. Siempre se ve: en reposo, en cero. */
export function barraTokens(brain?: Brain): string {
  const m = brain?.metrics()
  const hubo = !!m && (m.chars > 0 || m.tokIn > 0 || m.tokOut > 0)
  const tok = !hubo
    ? paint(C.brcyan, "0")
    : m!.tokIn > 0
      ? paint(C.brcyan, `${miles(m!.tokIn)}→${miles(m!.tokOut)}`)
      : paint(C.brcyan, `${miles(m!.tokOut)} salida`)
  let s = paint(C.dim, "tokens ") + tok
  if (hubo && m!.tps > 0) s += paint(C.dim, "  ·  ") + paint(C.brgreen, `${m!.tps.toFixed(1)} tok/s`)
  if (hubo && m!.tokReason > 0) s += paint(C.dim, `  ·  razón ${miles(m!.tokReason)}`)
  if (hubo) {
    const seg = m!.live ? `${Math.round(m!.ms / 1000)}s` : `${(m!.ms / 1000).toFixed(1)} s`
    s += paint(C.dim, "  ·  ") + paint(C.dim, seg)
  }
  s += m?.live ? paint(C.brcyan, "  generando") : paint(C.dim, hubo ? "  listo" : "")
  return s
}

function entropyColor(e: Entropy): string {
  if (e.value < 0.35) return C.dim
  if (e.value < 0.6) return C.brcyan
  return C.brmagenta
}

/** Entropía global de la Wired, con su barrita. */
export function barraEntropia(e: Entropy | null): string {
  if (!e) return paint(C.dim, "entropía sin señal")
  return paint(C.dim, "entropía ") + paint(entropyColor(e), `${e.bar} ${String(e.pct).padStart(3)}%`)
}

/** La barra de abajo entera: the wired · tokens · entropía. */
export function barraAbajo(o: { wired: WiredBar; brain?: Brain; entropy: Entropy | null }): string {
  return [barraWired(o.wired), barraTokens(o.brain), barraEntropia(o.entropy)].join(paint(C.dim, " · "))
}
