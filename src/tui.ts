import readline from "node:readline"
import { C, paint, box, stripAnsi, truncateVisible } from "./theme.js"
import { mdLines, sinGuionesLargos } from "./md.js"

export type Role = "user" | "lain" | "system" | "error" | "tool" | "plain" | "ok" | "title"

export function visLen(s: string): number {
  return stripAnsi(s).length
}

function padTo(s: string, w: number): string {
  const t = visLen(s) > w ? truncateVisible(s, w) : s
  const n = w - visLen(t)
  return n > 0 ? t + " ".repeat(n) : t
}

/** Un tick del efecto letra por letra (≈55 letras por segundo). */
const TYPE_TICK_MS = 18
/** Cuánta cola aguantamos antes de soltar más de una letra por tick. */
const TYPE_BACKLOG = 120
const TYPE_BACKLOG_BIG = 480
/** Si no llega texto por este rato, el sonido de tecleo se detiene. */
const TYPE_IDLE_MS = 1200

/**
 * Cuántas letras suelta cada tick. Siempre de a una; solo si el modelo se
 * adelanta mucho se apura, y nunca más de tres: si no, deja de verse el efecto.
 */
export function letrasPorTick(cola: number): number {
  if (cola > TYPE_BACKLOG_BIG) return 3
  if (cola > TYPE_BACKLOG) return 2
  return 1
}

/** No parte un par sustituto (emoji) al medio. */
function corteSeguro(s: string, n: number): number {
  if (n <= 0) return 0
  if (n >= s.length) return s.length
  const code = s.charCodeAt(n - 1)
  return code >= 0xd800 && code <= 0xdbff ? n + 1 : n
}

/** Envuelve texto plano (sin ANSI) en líneas de ancho `width`. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  if (width < 4) width = 4
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of raw.split(/(\s+)/)) {
      if (word === "") continue
      if (line.length + word.length <= width) {
        line += word
        continue
      }
      if (line.trim() !== "") {
        out.push(line.replace(/\s+$/, ""))
        line = ""
      }
      if (word.length > width) {
        let w = word.replace(/^\s+/, "")
        while (w.length > width) {
          out.push(w.slice(0, width))
          w = w.slice(width)
        }
        line = w
      } else {
        line = word.replace(/^\s+/, "")
      }
    }
    if (line !== "") out.push(line.replace(/\s+$/, ""))
  }
  return out
}

interface Skin {
  tag: string
  tagColor: string
  body: string
}

const SKINS: Record<Role, Skin> = {
  user: { tag: "", tagColor: C.brmagenta, body: C.bold },
  lain: { tag: "", tagColor: C.brcyan, body: "" },
  system: { tag: "  · ", tagColor: C.dim, body: C.dim },
  error: { tag: "  ! ", tagColor: C.brred, body: C.brred },
  tool: { tag: "  ⟐ ", tagColor: C.dim, body: C.dim },
  plain: { tag: "", tagColor: "", body: "" },
  ok: { tag: "", tagColor: C.brgreen, body: C.brgreen },
  title: { tag: "", tagColor: C.brcyan, body: C.brcyan },
}

interface Msg {
  role: Role
  text: string
  blank: boolean
}

/** Columnas mínimas para que el chat merezca ir al lado del retrato. */
const MIN_CHAT_COLS = 30
/** Filas mínimas de chat cuando el retrato va arriba. */
const MIN_CHAT_ROWS = 3

export interface TuiOptions {
  userName: string
  brainName?: string
}

/**
 * Terminal de dos paneles: arte a la izquierda, chat a la derecha.
 * Si stdout/stdin no son TTY, degrada a salida lineal (para pipes/tests).
 */
export class Tui {
  readonly tty: boolean
  private out = process.stdout
  private userName: string
  private brainName: string

  private left: string[] = []
  private leftFrames: string[][] = []
  private msgs: Msg[] = []
  private buf = ""
  private busy: string | null = null
  private busyLabel = ""
  /** Cola del efecto "letra por letra": el texto llega en tokens, se suelta de a poco. */
  private typeQueue = ""
  private typeTimer: NodeJS.Timeout | null = null
  /** Quien espera a que se vacíe la cola (endStream). */
  private typeWaiter: (() => void) | null = null
  /** Corta el sonido de tecleo si el texto se queda quieto un rato. */
  private typeIdle: NodeJS.Timeout | null = null
  private typing = false
  private statusL = ""
  private statusR = ""
  /** La barra de abajo: un texto fijo o algo que se arma con el ancho real. */
  private stats: string | ((cols: number) => string) = ""
  private promptLabel = "› "
  private spin = 0
  private scroll = 0
  private cmdHints: Array<[string, string]> = []
  /** Estado del tabulador: candidatos del comando y por cuál va. */
  private tabRun: { matches: string[]; i: number; out: string; resto: string } | null = null
  /** Historial de lo que escribiste (se recorre con flecha arriba/abajo). */
  private history: string[] = []
  private histIndex: number | null = null
  private histDraft = ""
  /** Fila elegida dentro de la lista de comandos (flecha arriba/abajo). */
  private hintSel = 0
  /** Subagente en curso, si lo hay: alimenta el recuadro sobre el composer. */
  private subagente: { descripcion: string; agente: string; desde: number } | null = null

  private cols = 100
  private rows = 40
  private timer: NodeJS.Timeout | null = null
  private submit: ((s: string | null) => void) | null = null

  onInterrupt: (() => void) | null = null
  /**
   * Se dispara con ctrl+x (a propósito, no con Esc: Esc se pulsa sin querer y
   * en psmux/tmux está a un dedo de todo).
   */
  onStop: (() => void) | null = null
  /** Avisa cuando empieza/termina el efecto letra por letra (lo usa el sonido de tecleo). */
  onTyping: ((on: boolean) => void) | null = null

  private rl?: readline.Interface
  private queue: string[] = []
  private waiting: ((s: string | null) => void) | null = null
  private closed = false
  private escPartial = ""
  private escTimer: NodeJS.Timeout | null = null
  private escPending = false

  constructor(opts: TuiOptions) {
    this.userName = opts.userName
    this.brainName = opts.brainName ?? "lain"
    this.tty = Boolean(process.stdout.isTTY && process.stdin.isTTY)
    this.resize()
  }

  private resize(): void {
    this.cols = this.out.columns ?? 100
    this.rows = this.out.rows ?? 40
  }

  start(): void {
    if (this.tty) {
      this.out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h")
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", this.onData)
      this.out.on("resize", this.onResize)
    } else {
      this.rl = readline.createInterface({ input: process.stdin, output: undefined })
      this.rl.on("line", (l) => {
        const w = this.waiting
        if (w) {
          this.waiting = null
          w(l)
        } else this.queue.push(l)
      })
      this.rl.on("close", () => {
        this.closed = true
        const w = this.waiting
        if (w) {
          this.waiting = null
          w(null)
        }
      })
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flushTyping()
    if (this.escTimer) clearTimeout(this.escTimer)
    this.escTimer = null
    if (this.tty) {
      process.stdin.off("data", this.onData)
      this.out.off("resize", this.onResize)
      try {
        process.stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
      process.stdin.pause()
      this.out.write(`\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l`)
    } else {
      this.rl?.close()
    }
  }

  private onResize = (): void => {
    this.resize()
    this.refresh()
  }

  private onData = (d: Buffer): void => {
    if (this.escTimer) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
    let raw = d.toString("utf8")
    // Esc suelto + continuación de una secuencia partida entre dos lecturas.
    if (this.escPending && /^[[O]/.test(raw)) raw = "\x1b" + raw
    this.escPending = false
    const s = this.escPartial + raw
    this.escPartial = ""
    if (s === "\x1b") {
      // Esc suelto (o la primera mitad de una flecha que aún no llegó): no
      // frenamos nada, solo esperamos a ver si la secuencia sigue.
      this.armEsc()
      return
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      const code = ch.charCodeAt(0)
      if (code === 3) {
        const r = this.submit
        this.submit = null
        if (r) r(null)
        this.onInterrupt?.()
        return
      }
      if (code === 4) {
        if (this.buf === "") {
          const r = this.submit
          this.submit = null
          if (r) r(null)
          this.onInterrupt?.()
          return
        }
        continue
      }
      if (ch === "\x1b") {
        const rest = s.slice(i)
        const m = /^\x1b\[([0-9;?<]*)([A-Za-z~])/.exec(rest)
        if (m) {
          const params = m[1] ?? ""
          const final = m[2]!
          let adv = m[0].length
          if (final === "M" && params === "") {
            // Ratón en codificación X10 (sin SGR): llegan 3 bytes crudos después de "\x1b[M".
            const b = (s.charCodeAt(i + adv) || 0) - 32
            if ((b & 64) !== 0) this.onEscape(`<${b};0;0`, "M")
            adv += 3
          } else {
            this.onEscape(params, final)
          }
          i += adv - 1
        } else if (rest.length > 1) {
          // Secuencia partida entre dos lecturas: la completamos en la siguiente.
          this.escPartial = rest
          break
        } else {
          this.armEsc()
        }
        continue
      }
      if (code === 24) {
        // ctrl+x: frena la generación en curso.
        this.onStop?.()
        continue
      }
      if (code === 9) {
        this.complete()
        continue
      }
      if (ch === "\r" || ch === "\n") {
        this.commit()
        continue
      }
      if (code === 127 || code === 8) {
        this.buf = this.buf.slice(0, -1)
        this.tabRun = null
        this.hintSel = 0
        this.histIndex = null
        this.refresh()
        continue
      }
      if (code === 21) {
        this.scrollBy(5)
        continue
      }
      if (code === 1) {
        this.scroll = 1e9
        this.refresh()
        continue
      }
      if (code === 5) {
        this.scroll = 0
        this.refresh()
        continue
      }
      if (code >= 32) {
        this.buf += ch
        this.tabRun = null
        this.hintSel = 0
        this.histIndex = null
        this.refresh()
      }
    }
  }

  /**
   * Un Esc suelto: miramos si en la lectura siguiente llega el resto de una
   * secuencia (flecha, rueda). No frena nada por su cuenta.
   */
  private armEsc(): void {
    this.escPending = true
    this.escTimer = setTimeout(() => {
      this.escTimer = null
      this.escPending = false
    }, 45)
  }

  /** Teclas de navegación y rueda del ratón (SGR). */
  private onEscape(params: string, final: string): void {
    if (final === "A") this.navUp()
    else if (final === "B") this.navDown()
    else if (final === "~") {
      if (params === "5") this.scrollBy(10)
      else if (params === "6") this.scrollBy(-10)
      else if (params === "1" || params === "7") this.scroll = 1e9
      else if (params === "4" || params === "8") this.scroll = 0
    } else if ((final === "M" || final === "m") && params.startsWith("<")) {
      const parts = params.slice(1).split(";")
      const b = Number(parts[0] ?? "")
      if (b === 64) this.scrollBy(3)
      else if (b === 65) this.scrollBy(-3)
    }
    this.refresh()
  }

  /**
   * Flecha arriba: con la lista de comandos abierta mueve la elección; si no,
   * retrocede por el historial de prompts.
   */
  private navUp(): void {
    const items = this.hintItems()
    if (items.length) {
      this.hintSel = Math.max(0, Math.min(this.hintSel, items.length - 1) - 1)
      return
    }
    if (!this.history.length) return
    if (this.histIndex === null) {
      this.histDraft = this.buf
      this.histIndex = this.history.length - 1
    } else if (this.histIndex > 0) {
      this.histIndex--
    }
    this.buf = this.history[this.histIndex]!
    this.tabRun = null
  }

  /** Flecha abajo: baja en la lista de comandos o vuelve hacia lo más reciente. */
  private navDown(): void {
    const items = this.hintItems()
    if (items.length) {
      this.hintSel = Math.min(items.length - 1, this.hintSel + 1)
      return
    }
    if (this.histIndex === null) return
    if (this.histIndex < this.history.length - 1) {
      this.histIndex++
      this.buf = this.history[this.histIndex]!
    } else {
      this.histIndex = null
      this.buf = this.histDraft
    }
    this.tabRun = null
  }

  /** Desplaza el chat; positivo = hacia atrás en la conversación. */
  scrollBy(delta: number): void {
    this.scroll = Math.max(0, this.scroll + delta)
    this.refresh()
  }

  private commit(): void {
    // Con la lista de comandos abierta, Enter elige el resaltado (y recién
    // después se manda). Si ya escribiste el comando entero, la lista queda
    // vacía y Enter lo envía directo.
    const items = this.hintItems()
    if (items.length) {
      this.buf = items[Math.min(this.hintSel, items.length - 1)]![0]
      this.tabRun = null
      this.hintSel = 0
      this.refresh()
      return
    }
    const line = this.buf
    if (line.trim() && this.history[this.history.length - 1] !== line) {
      this.history.push(line)
      if (this.history.length > 200) this.history.shift()
    }
    this.buf = ""
    this.scroll = 0
    this.tabRun = null
    this.histIndex = null
    this.histDraft = ""
    this.hintSel = 0
    const r = this.submit
    this.submit = null
    this.refresh()
    if (r) r(line)
  }

  /**
   * Tab: completa el comando que estás escribiendo, y con varios candidatos va
   * pasando por todos a cada Tab. Si escribís algo, la lista arranca de nuevo.
   */
  private complete(): void {
    const b = this.buf
    if (!b.startsWith("/")) return
    const sp = b.indexOf(" ")
    const word = sp === -1 ? b : b.slice(0, sp)
    if (this.tabRun && this.tabRun.out === b) {
      this.tabRun.i = (this.tabRun.i + 1) % this.tabRun.matches.length
    } else {
      const matches = this.cmdHints
        .filter(([c]) => c.startsWith("/"))
        // Del texto de ayuda solo nos interesa el comando (p. ej. "/publish [--last N]").
        .map(([c]) => c.split(" ")[0]!)
        .filter((c) => c.toLowerCase().startsWith(word.toLowerCase()))
      if (!matches.length) {
        this.tabRun = null
        return
      }
      this.tabRun = { matches, i: 0, out: "", resto: sp === -1 ? "" : b.slice(sp) }
    }
    this.tabRun.out = this.tabRun.matches[this.tabRun.i]! + this.tabRun.resto
    this.buf = this.tabRun.out
    this.refresh()
  }

  /** Lee una línea del usuario (prompt inferior). */
  input(label = "› "): Promise<string | null> {
    if (!this.tty) return this.readLinePipe(label)
    this.promptLabel = label
    this.refresh()
    return new Promise((resolve) => {
      this.submit = resolve
    })
  }

  private readLinePipe(label: string): Promise<string | null> {
    process.stdout.write(label)
    if (this.queue.length) return Promise.resolve(this.queue.shift()!)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  setLeft(lines: string[]): void {
    this.left = lines
  }

  /** Fotogramas del retrato que se muestran (en bucle) mientras lain genera. */
  setLeftAnimation(frames: string[][]): void {
    this.leftFrames = frames
  }

  clear(): void {
    this.msgs = []
    this.busy = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.tty) process.stdout.write("\x1b[2J\x1b[H")
    this.refresh()
  }

  setStatus(left: string, right: string): void {
    this.statusL = left
    this.statusR = right
  }

  /** Barra de abajo: tokens y velocidad. Se repinta con cada delta. */
  setStats(barra: string | ((cols: number) => string)): void {
    this.stats = barra
  }

  /** Cambia la etiqueta del spinner mientras lain trabaja. */
  setStreamLabel(label: string): void {
    this.busyLabel = label
    this.refresh()
  }

  /** Tabla de comandos usada para la caja de ayuda al escribir "/". */
  setCommandHints(rows: Array<[string, string]>): void {
    this.cmdHints = rows
  }

  /** Muestra un recuadro dentro del chat. */
  pushBox(title: string, lines: string[]): void {
    const width = this.tty ? Math.min(64, Math.max(30, this.rightWidth())) : 62
    this.push("plain", box(title, lines, width))
  }

  /** Comandos que pegan con lo que vas escribiendo (todos: la caja los ventila). */
  private hintItems(): Array<[string, string]> {
    const b = this.buf.trim()
    if (!b.startsWith("/")) return []
    const q = b.toLowerCase()
    const base = this.cmdHints.filter(([c]) => c.startsWith("/"))
    return q === "/" ? base : base.filter(([c]) => c.toLowerCase().startsWith(q) && c.toLowerCase() !== q)
  }

  /** Cuántas filas de comando se ven a la vez (la ventana sigue a la selección). */
  private static readonly HINT_WINDOW = 6

  private hintBox(width: number): string[] {
    const items = this.hintItems()
    if (!items.length) return []
    const sel = Math.min(this.hintSel, items.length - 1)
    const ventana = Math.min(Tui.HINT_WINDOW, items.length)
    // La ventana sigue a la selección: si seguís bajando, la lista se desplaza
    // y así llegás a todos los comandos aunque no entren de una.
    let desde = 0
    if (items.length > ventana) {
      desde = Math.min(Math.max(0, sel - Math.floor(ventana / 2)), items.length - ventana)
    }
    const visibles = items.slice(desde, desde + ventana)
    const plain = visibles.map(([c, d], j) => `${desde + j === sel ? "▸" : " "} ${c.padEnd(18)} ${d}`)
    const need = Math.max(...plain.map((r) => r.length)) + 4
    const w = Math.min(Math.max(need, 20), Math.max(20, width))
    const inner = Math.max(6, w - 4)
    const head = items.length > ventana ? ` comandos ${sel + 1}/${items.length} ` : " comandos "
    const top = "╭─" + head + "─".repeat(Math.max(0, w - 4 - head.length + 1)) + "╮"
    const bot = "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"
    const mid = plain.map((line, j) => {
      const pintado = desde + j === sel ? paint(C.bold + C.brcyan, line) : line
      return "│ " + padTo(pintado, inner) + " │"
    })
    return [top, ...mid, bot]
  }

  /** Recuadro sobre el composer: qué subagente corre y desde cuándo. */
  private subagenteBox(width: number): string[] {
    const s = this.subagente
    if (!s) return []
    const seg = Math.max(0, Math.floor((Date.now() - s.desde) / 1000))
    const reloj = `${String(Math.floor(seg / 60)).padStart(2, "0")}:${String(seg % 60).padStart(2, "0")}`
    const w = Math.max(28, Math.min(width, 72))
    const inner = Math.max(6, w - 4)
    const head = " subagente "
    const top = "╭─" + head + "─".repeat(Math.max(0, w - 4 - head.length + 1)) + "╮"
    const bot = "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"
    const linea = `${paint(C.brgreen, "⏱ " + reloj)}  ${paint(C.brmagenta, s.agente)}  ${paint(C.brcyan, s.descripcion)}`
    return [top, "│ " + padTo(linea, inner) + " │", bot]
  }

  /** Muestra (o esconde) el recuadro del subagente sobre el composer. */
  setSubagente(s: { descripcion: string; agente?: string; desde: number } | null): void {
    this.subagente = s ? { descripcion: s.descripcion, agente: s.agente ?? "general", desde: s.desde } : null
    this.refresh()
  }

  /** Marca de agua tenue que flota bajo el texto mientras lain escribe. */
  private watermark(width: number): string {
    const que = /razon|pens/i.test(this.busyLabel) ? "pensando" : "escribiendo"
    const txt = `░░ ${this.brainName} está ${que} ░░`
    const m = truncateVisible(txt, Math.max(8, width - 1))
    return " ".repeat(Math.max(0, width - visLen(m))) + paint(C.dim, m)
  }

  /**
   * Ancho útil: se deja libre la última columna. Escribir en la celda inferior
   * derecha hace que conhost/Windows Terminal hagan scroll de una línea, lo que
   * corta el mensaje de arriba y deja un fragmento suelto abajo.
   */
  private safeCols(): number {
    return Math.max(8, this.cols - 1)
  }

  /**
   * Líneas del panel de la izquierda que tocan ahora mismo (arte o fotograma).
   */
  private leftLinesNow(): string[] {
    return this.busy !== null && this.leftFrames.length
      ? this.leftFrames[this.spin % this.leftFrames.length]!
      : this.left
  }

  /**
   * Reparto del ancho: el retrato manda. Si a su lado cabe un chat con un
   * mínimo de columnas, van de lado; si no, el retrato arriba y el chat debajo
   * — antes al angostar la terminal se recortaba el arte, y no queremos.
   */
  private columnPlan(): { dos: boolean; leftW: number; rightW: number; artW: number } {
    const cols = this.safeCols()
    let artW = 0
    for (const ln of this.leftLinesNow()) artW = Math.max(artW, visLen(ln))
    if (artW === 0) return { dos: false, leftW: 0, rightW: cols, artW: 0 }
    if (artW + MIN_CHAT_COLS <= cols - 1) {
      const leftW = artW + 1
      return { dos: true, leftW, rightW: Math.max(MIN_CHAT_COLS, cols - leftW - 1), artW }
    }
    return { dos: false, leftW: 0, rightW: cols, artW }
  }

  rightWidth(): number {
    return this.columnPlan().rightW
  }

  /**
   * Filas que puede ocupar el panel izquierdo (retrato + avisos) sin comerse el
   * chat. Se usa para no cortar un aviso a la mitad: solo entran avisos enteros.
   */
  leftBudget(): number {
    const bodyRows = Math.max(1, this.rows - 2)
    const plan = this.columnPlan()
    const hintH = this.hintBox(plan.rightW).length
    const subH = this.subagenteBox(plan.rightW).length
    return plan.dos
      ? Math.max(0, bodyRows - 1 - hintH - subH)
      : Math.max(0, bodyRows - 1 - hintH - subH - MIN_CHAT_ROWS)
  }

  push(role: Role, text: string, blank = true): void {
    this.msgs.push({ role, text, blank })
    if (this.scroll > 0) this.scroll += text.split("\n").length + (blank ? 1 : 0)
    if (!this.tty) {
      const skin = this.skinFor(role)
      for (const ln of text.split("\n")) process.stdout.write(skin.tag + ln + "\n")
      if (blank) process.stdout.write("\n")
      return
    }
    this.refresh()
  }

  beginStream(label: string): void {
    this.busy = ""
    this.busyLabel = label
    if (this.tty && !this.timer) {
      this.timer = setInterval(() => {
        this.spin++
        this.refresh()
      }, 120)
    }
    this.refresh()
  }

  streamChunk(chunk: string): void {
    if (this.busy === null) return // turno ya cerrado: la respuesta buena ya está puesta
    if (!this.tty) {
      // sin tty (tests/tubería) el texto se ve entero: no hay dónde animarlo
      this.busy = sinGuionesLargos(this.busy + chunk)
      return
    }
    // El modelo entrega tokens; acá se sueltan de a poco para el efecto "letra por letra".
    this.typeQueue += chunk
    this.setTyping(true)
    this.armaIdle()
    if (!this.typeTimer) this.typeTimer = setInterval(() => this.drainType(), TYPE_TICK_MS)
  }

  /** Suelta unas letras de la cola; si se acumuló mucho, apura un poco (nunca de golpe). */
  private drainType(): void {
    if (this.busy === null || this.typeQueue.length === 0) {
      this.stopDrain()
      if (this.typeWaiter) this.cierraTipeo()
      return
    }
    const k = corteSeguro(this.typeQueue, letrasPorTick(this.typeQueue.length))
    const take = this.typeQueue.slice(0, k)
    this.typeQueue = this.typeQueue.slice(k)
    this.busy = sinGuionesLargos(this.busy + take)
    this.refresh()
  }

  /** Suelta lo que falte de una (ctrl+x mientras se escribe). */
  flushTyping(): void {
    if (this.typeQueue) {
      if (this.busy !== null) this.busy = sinGuionesLargos(this.busy + this.typeQueue)
      this.typeQueue = ""
    }
    this.cierraTipeo()
  }

  private stopDrain(): void {
    if (this.typeTimer) clearInterval(this.typeTimer)
    this.typeTimer = null
  }

  /** Corta la animación y avisa que ya no se está escribiendo. */
  private cierraTipeo(): void {
    this.stopDrain()
    if (this.typeWaiter) {
      const r = this.typeWaiter
      this.typeWaiter = null
      r()
    }
    if (this.typeIdle) {
      clearTimeout(this.typeIdle)
      this.typeIdle = null
    }
    this.setTyping(false)
  }

  /** El sonido de tecleo se corta si pasa un rato sin texto nuevo. */
  private armaIdle(): void {
    if (this.typeIdle) clearTimeout(this.typeIdle)
    this.typeIdle = setTimeout(() => {
      this.typeIdle = null
      this.setTyping(false)
    }, TYPE_IDLE_MS)
  }

  /** Avisa al exterior (sonido de tecleo) cuando se empieza o deja de escribir. */
  private setTyping(on: boolean): void {
    if (on && this.typeIdle) {
      clearTimeout(this.typeIdle)
      this.typeIdle = null
    }
    if (this.typing === on) return
    this.typing = on
    this.onTyping?.(on)
  }

  /**
   * Cierra el turno. Si todavía quedan letras en la cola se siguen escribiendo
   * —no aparecen de golpe— y recién cuando termina se fija el mensaje.
   */
  async endStream(finalText?: string): Promise<string> {
    if (this.typeQueue.length && this.busy !== null) {
      await new Promise<void>((r) => (this.typeWaiter = r))
    }
    this.cierraTipeo()
    const streamed = this.busy ?? ""
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.busy = null
    const a = (finalText ?? "").trim()
    const b = streamed.trim()
    const text = sinGuionesLargos(a.length >= b.length ? (finalText ?? "") : streamed)
    if (text.trim()) {
      this.push("lain", text)
      return text
    }
    return ""
  }

  refresh(): void {
    if (!this.tty) return
    this.render()
  }

  private spinnerText(): string {
    const frames = "▓▒░▒"
    return frames[this.spin % frames.length]!
  }

  private skinFor(role: Role): Skin {
    const s = SKINS[role]
    if (role === "user") return { ...s, tag: `${this.userName} ▸ ` }
    if (role === "lain") return { ...s, tag: `${this.brainName} ▸ ` }
    return s
  }

  private chatLines(width: number): string[] {
    const out: string[] = []
    const inner = Math.max(12, width - 8)
    for (const m of this.msgs) {
      const skin = this.skinFor(m.role)
      const lines = m.role === "lain" ? mdLines(m.text, inner) : wrapText(m.text, inner)
      const indent = " ".repeat(visLen(skin.tag))
      lines.forEach((ln, i) => {
        const prefix = i === 0 ? paint(skin.tagColor, skin.tag) : indent
        out.push(prefix + (skin.body ? paint(skin.body, ln) : ln))
      })
      if (m.blank) out.push("")
    }
    if (this.busy !== null) {
      const tag = `${this.brainName} ▸ `
      if (this.busy === "") {
        out.push(paint(C.brcyan, tag) + paint(C.dim, `${this.spinnerText()} ${this.busyLabel}`))
      } else {
        const lines = mdLines(this.busy, inner)
        lines.forEach((ln, i) => {
          const prefix = i === 0 ? paint(C.brcyan, tag) : " ".repeat(visLen(tag))
          out.push(prefix + ln)
        })
      }
    }
    return out
  }

  private render(): void {
    const cols = this.safeCols()
    const rows = this.rows
    const plan = this.columnPlan()
    const divW = plan.dos ? 1 : 0
    const rightW = plan.rightW
    const hints = this.hintBox(rightW)
    const hintH = hints.length
    const sub = this.subagenteBox(rightW)
    const subH = sub.length
    // Fila 1: estado. Última fila: la barra de tokens. El resto: cuerpo.
    const bodyRows = Math.max(1, rows - 2)

    const chat = this.chatLines(rightW)
    const leftLines = this.leftLinesNow()
    // Con el chat debajo, el retrato se lleva solo lo que sobra por arriba.
    const artH = plan.dos
      ? 0
      : Math.min(leftLines.length, Math.max(0, bodyRows - 1 - hintH - subH - MIN_CHAT_ROWS))
    const chatRows = Math.max(1, bodyRows - 1 - hintH - subH - artH)
    const maxScroll = Math.max(0, chat.length - chatRows)
    if (this.scroll > maxScroll) this.scroll = maxScroll
    const end = chat.length - this.scroll
    const view = chat.slice(Math.max(0, end - chatRows), end)

    const buf: string[] = [`\x1b[?25l`]
    const statusLfull = this.statusL + (this.busy !== null ? paint(C.dim, "  ·  ctrl+x para cortar") : "")
    const statusRfull = (this.scroll > 0 ? paint(C.dim, `⇡ ${this.scroll}  `) : "") + this.statusR
    const need = visLen(statusLfull) + visLen(statusRfull)
    const statusLine =
      need + 1 <= cols
        ? statusLfull + " ".repeat(cols - need) + statusRfull
        : truncateVisible(statusLfull + "  " + statusRfull, cols)
    buf.push(`\x1b[1;1H\x1b[2K${statusLine}`)

    const pref = visLen(this.promptLabel)
    const room = Math.max(0, rightW - pref - 1)
    const shown = this.buf.length > room ? this.buf.slice(-room) : this.buf
    const inputLine = truncateVisible(this.promptLabel + shown, rightW)
    const margen = Math.max(0, Math.floor((cols - plan.artW) / 2))
    const vacio = " ".repeat(plan.leftW) + (divW ? paint(C.gray, "│") : "")

    for (let i = 0; i < bodyRows; i++) {
      const row = i + 2
      let content: string
      if (i < artH) {
        // Retrato arriba, centrado, con todo su ancho.
        content = padTo(truncateVisible(" ".repeat(margen) + (leftLines[i] ?? ""), cols), cols)
      } else if (i < artH + chatRows) {
        const idx = i - artH
        let right = idx < view.length ? view[idx]! : ""
        // Marca de agua: en la primera fila libre bajo el texto, mientras escribe.
        if (!right && this.busy !== null && idx === view.length) right = this.watermark(rightW)
        const left = truncateVisible(leftLines[idx] ?? "", plan.leftW)
        content = plan.dos
          ? padTo(left, plan.leftW) + paint(C.gray, "│") + padTo(right, rightW)
          : padTo(right, rightW)
      } else if (i < artH + chatRows + hintH) {
        const right = hints[i - artH - chatRows]!
        content = vacio + padTo(right, rightW)
      } else if (i < artH + chatRows + hintH + subH) {
        const right = sub[i - artH - chatRows - hintH]!
        content = vacio + padTo(right, rightW)
      } else {
        content = vacio + padTo(inputLine, rightW)
      }
      buf.push(`\x1b[${row};1H\x1b[2K${content}`)
    }
    const pie = " " + (typeof this.stats === "function" ? this.stats(cols) : this.stats)
    buf.push(`\x1b[${rows};1H\x1b[2K${truncateVisible(pie, cols)}`)
    this.out.write(buf.join(""))

    const col = Math.min(cols, plan.leftW + divW + pref + visLen(shown) + 1)
    this.out.write(`\x1b[${Math.max(2, rows - 1)};${col}H\x1b[?25h`)
  }
}
