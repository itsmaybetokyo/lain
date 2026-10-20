const esc = (n: number) => `\x1b[${n}m`

export const C = {
  reset: esc(0),
  dim: esc(2),
  bold: esc(1),
  italic: esc(3),
  inv: esc(7),
  red: esc(31),
  green: esc(32),
  yellow: esc(33),
  blue: esc(34),
  magenta: esc(35),
  cyan: esc(36),
  white: esc(37),
  gray: esc(90),
  brred: esc(91),
  brgreen: esc(92),
  bryellow: esc(93),
  brcyan: esc(96),
  brmagenta: esc(95),
}

/** Símbolos del tema. */
export const S = {
  root: "◈",
  node: "◦",
  wire: "┄",
  poke: "▸",
  lain: "lain",
  glitch: "▓▒░",
}

export function paint(color: string, text: string): string {
  return `${color}${text}${C.reset}`
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Recorta respetando los códigos ANSI. */
export function truncateVisible(s: string, max: number): string {
  // Si ya entra, se devuelve tal cual: recortar acá le comería el último
  // carácter a una línea que mide justo el ancho disponible.
  if (stripAnsi(s).length <= max) return s
  let vis = 0
  let out = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    if (vis >= max - 1) return out + "…" + C.reset
    out += s[i]
    vis++
    i++
  }
  return out
}

/** Deja los primeros `max` caracteres visibles, conservando los códigos ANSI.
 *  A diferencia de `truncateVisible`, no agrega "…": sirve para revelar de a poco. */
export function sliceVisible(s: string, max: number): string {
  let vis = 0
  let out = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    if (vis >= max) return out + C.reset
    out += s[i]
    vis++
    i++
  }
  return out
}

const GL = "!<>-_\\/[]{}—=+*^?#________▓▒░¤§¥Ω"
/** Corrompe un texto y lo va resolviendo hacia el destino (efecto glitch). */
export function glitchText(target: string, frame: number, resolvedRatio: number): string {
  const keep = Math.floor(target.length * resolvedRatio)
  let out = ""
  for (let i = 0; i < target.length; i++) {
    if (i < keep || target[i] === " ") out += target[i]
    else out += GL[(frame * 7 + i * 13) % GL.length]
  }
  return out
}

export function box(title: string, lines: string[], width = 62): string {
  const inner = width - 2
  const top = `╭${"─".repeat(inner)}╮`
  const head = `│ ${paint(C.brmagenta, title.padEnd(inner - 1))}│`
  const body = lines.map((l) => {
    const clamped = truncateVisible(l, inner - 1)
    const vis = stripAnsi(clamped).length
    const pad = Math.max(0, inner - 1 - vis)
    return `│ ${clamped}${" ".repeat(pad)}│`
  })
  const bot = `╰${"─".repeat(inner)}╯`
  return [top, head, ...body, bot].join("\n")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Escribe con efecto de terminal, carácter por carácter. */
export async function typewrite(text: string, delay = 8): Promise<void> {
  for (const ch of text) {
    process.stdout.write(ch)
    if (ch !== " " && ch !== "\n") await sleep(delay)
  }
}
