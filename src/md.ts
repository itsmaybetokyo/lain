/**
 * Markdown mínimo para la terminal: negrita, cursiva, código, tachado,
 * encabezados, listas, citas y bloques de código.
 * Se aplica al vuelo en cada render, así que los marcadores a medio escribir
 * (por ejemplo "**bo" mientras llega el stream) se ven tal cual hasta cerrarse.
 */

interface Style {
  bold?: boolean
  italic?: boolean
  dim?: boolean
  strike?: boolean
  code?: boolean
  color?: number
}

export interface Seg {
  text: string
  style: Style
}

/** Los guiones largos y medios no le gustan al usuario: los cambio por lo que toca. */
export function sinGuionesLargos(texto: string): string {
  return texto
    .replace(/(\d)[—–](\d)/g, "$1-$2")
    .replace(/(^|\n)[ \t]*[—–][ \t]*/g, "$1- ")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
}

function fmt(seg: Seg): string {
  if (!seg.text) return ""
  const codes: number[] = []
  if (seg.style.bold) codes.push(1)
  if (seg.style.italic) codes.push(3)
  if (seg.style.dim) codes.push(2)
  if (seg.style.strike) codes.push(9)
  if (seg.style.code) codes.push(36)
  if (seg.style.color != null) codes.push(seg.style.color)
  if (!codes.length) return seg.text
  return `\x1b[${codes.join(";")}m${seg.text}\x1b[0m`
}

/** Convierte una línea en trozos con estilo. Marcadores sin cerrar quedan literales. */
export function tokenize(line: string): Seg[] {
  const out: Seg[] = []
  let buf = ""
  const flush = (): void => {
    if (buf) {
      out.push({ text: buf, style: {} })
      buf = ""
    }
  }
  let i = 0
  while (i < line.length) {
    const two = line.slice(i, i + 2)
    if (two === "**" || two === "__") {
      const end = line.indexOf(two, i + 2)
      if (end > i + 2) {
        flush()
        for (const s of tokenize(line.slice(i + 2, end))) out.push({ text: s.text, style: { ...s.style, bold: true } })
        i = end + 2
        continue
      }
    }
    if (two === "~~") {
      const end = line.indexOf("~~", i + 2)
      if (end > i + 2) {
        flush()
        for (const s of tokenize(line.slice(i + 2, end))) out.push({ text: s.text, style: { ...s.style, strike: true, dim: true } })
        i = end + 2
        continue
      }
    }
    const ch = line[i]!
    if (ch === "`") {
      const end = line.indexOf("`", i + 1)
      if (end > i + 1) {
        flush()
        out.push({ text: line.slice(i + 1, end), style: { code: true } })
        i = end + 1
        continue
      }
    }
    if ((ch === "*" || ch === "_") && (i === 0 || !/[\p{L}\p{N}]/u.test(line[i - 1]!))) {
      const end = line.indexOf(ch, i + 1)
      const intraword = ch === "_" && /[\p{L}\p{N}]/u.test(line[end + 1] ?? "")
      if (end > i + 1 && !intraword) {
        flush()
        for (const s of tokenize(line.slice(i + 1, end))) out.push({ text: s.text, style: { ...s.style, italic: true } })
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

interface Word {
  text: string
  style: Style
}

/** Envuelve trozos con estilo respetando el ancho visible. */
function wrapSegs(segs: Seg[], width: number): string[] {
  if (width < 4) width = 4
  const words: Word[] = []
  for (const seg of segs) for (const w of seg.text.split(/(\s+)/)) if (w !== "") words.push({ text: w, style: seg.style })
  const lines: Word[][] = []
  let cur: Word[] = []
  let len = 0
  for (const w of words) {
    const blank = w.text.trim() === ""
    if (cur.length && len + w.text.length > width) {
      lines.push(cur)
      cur = []
      len = 0
      if (blank) continue
    }
    if (!cur.length && blank) continue
    if (w.text.length > width) {
      let rest = w.text
      while (rest.length > width) {
        lines.push([{ text: rest.slice(0, width), style: w.style }])
        rest = rest.slice(width)
      }
      if (rest) {
        cur = [{ text: rest, style: w.style }]
        len = rest.length
      }
      continue
    }
    cur.push(w)
    len += w.text.length
  }
  if (cur.length) lines.push(cur)
  const out = lines.map((ws) => ws.map(fmt).join(""))
  return out.length ? out : [""]
}

const HR = /^\s*([-*_])\1{2,}\s*$/
const FENCE = /^\s*```/
const HEAD = /^(#{1,6})\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

/**
 * Texto markdown → líneas ya estilizadas y envueltas al ancho dado.
 * Los marcadores de bloque (``` # - >) no se imprimen.
 */
export function mdLines(text: string, width: number): string[] {
  const out: string[] = []
  let fence = false
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    if (FENCE.test(raw)) {
      fence = !fence
      continue
    }
    if (fence) {
      out.push(...wrapSegs([{ text: raw, style: { color: 90 } }], width))
      continue
    }
    if (raw.trim() === "") {
      out.push("")
      continue
    }
    if (HR.test(raw)) {
      out.push(fmt({ text: "─".repeat(Math.max(6, Math.min(width, 48))), style: { dim: true } }))
      continue
    }
    const head = HEAD.exec(raw)
    if (head) {
      const segs = tokenize(head[2]!).map((s) => ({ text: s.text, style: { ...s.style, bold: true, color: 96 } }))
      out.push(...wrapSegs(segs, width))
      continue
    }
    const quote = QUOTE.exec(raw)
    if (quote) {
      const segs = tokenize(quote[1]!).map((s) => ({ text: s.text, style: { ...s.style, color: 90 } }))
      out.push(...wrapSegs(segs, Math.max(6, width - 2)).map((l) => fmt({ text: "│ ", style: { dim: true } }) + l))
      continue
    }
    const bullet = BULLET.exec(raw)
    if (bullet) {
      const ordered = /^\d/.test(bullet[2]!)
      const mark = ordered ? `${bullet[2]} ` : "· "
      const pad = mark.length + bullet[1]!.length
      const segs = tokenize(bullet[3]!)
      out.push(...wrapSegs(segs, Math.max(6, width - pad)).map((l, i) => (i === 0 ? " ".repeat(bullet[1]!.length) + mark : " ".repeat(pad)) + l))
      continue
    }
    out.push(...wrapSegs(tokenize(raw), width))
  }
  return out
}
