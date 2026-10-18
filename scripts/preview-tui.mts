import { Tui } from "../src/tui.js"
import { mascot } from "../src/mascot.js"
import { C, paint } from "../src/theme.js"
import { barraAbajo } from "../src/bar.js"

const COLS = Number(process.argv[2] ?? 110)
const ROWS = Number(process.argv[3] ?? 34)

const HELPROWS: Array<[string, string]> = [
  ["<texto>", "habla con lain (responde opencode)"],
  ["/model", "elige proveedor + modelo"],
  ["/art", "retrato suave / compacto / completo"],
  ["/vault", "abre tu vault de Obsidian"],
  ["/whoami", "tu identidad y tu vault"],
  ["/publish [--last N]", "sube tu conocimiento a la Wired"],
  ["/search <q>", "busca en la Wired global"],
  ["/sync", "baja nodos remotos a tu vault"],
  ["/local", "tiempo y titulares de tu ciudad"],
  ["/entropia", "cómo está la entropía global ahora"],
  ["/wired", "estado del relay y nodos"],
  ["/mouse", "rueda: cédela a lain"],
  ["/clear", "limpia el chat"],
  ["/exit", "desconecta"],
]

let captured = ""
const realWrite = process.stdout.write.bind(process.stdout)
;(process.stdout as any).write = (s: any): boolean => {
  captured += String(s)
  return true
}
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true })
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true })
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
;(process.stdin as any).setRawMode = (): void => {}

const tui = new Tui({ userName: "ttttt", brainName: "lain" })
tui.start()
tui.setCommandHints(HELPROWS)
tui.setLeft([
  ...mascot({ say: "todo lo que digas queda en la Wired", mode: "smooth" }).split("\n"),
  "",
  paint(C.dim, "  ") + paint(C.brmagenta, "◈ ") + paint(C.brcyan, "ttttt") + paint(C.dim, "  nodo local"),
  paint(C.dim, "  3 notas · 1 remotos"),
  paint(C.dim, "  entropía ") + paint(C.brcyan, "▓▓▓░░  62%") + paint(C.dim, " · 3 nodos"),
  paint(C.dim, "  escribe / para ver comandos"),
])
tui.setStatus(
  paint(C.brmagenta, "▓▒░") + " " + paint(C.bold + C.brcyan, "lain") + paint(C.dim, "  ·  ") + paint(C.brcyan, "ttttt"),
  paint(C.dim, "modelo ") +
    paint(C.brcyan, "opencode/space-bunny-free") +
    paint(C.dim, "  ·  wired ") +
    paint(C.brgreen, "on · 7"),
)
tui.push("lain", "estoy aquí. todo lo que digas queda en la Wired.")
tui.push("system", "escribe /help para ver los comandos (o / y tab para verlos)")
tui.push("user", "hola, ¿en qué estás pensando?")
const fake = {
  metrics: () => ({
    tokIn: 812,
    tokOut: 417,
    tokReason: 96,
    cacheRead: 1200,
    costo: 0,
    ms: 12200,
    tps: 34.1,
    chars: 1668,
    live: true,
  }),
} as unknown as Parameters<typeof barraAbajo>[0]["brain"]
tui.setStats(
  barraAbajo({
    wired: { badge: "on", entries: 12, pend: 0 },
    brain: fake,
    entropy: { value: 0.62, pct: 62, bar: "▓▓▓░░" } as never,
  }),
)
tui.beginStream("razonando…")
setTimeout(() => {
  tui.streamChunk("Estoy pensando en la red. Lo que dices se graba en tu vault ")
  tui.streamChunk("y, si quieres, lo subimos a la **Wired** para que otros nodos lo lean.")
  tui.endStream()
  tui.push("user", "dame un ejemplo")
  tui.push(
    "lain",
    "## Protocolo 7\n\nDos cosas y un bloque:\n\n- el **peso** de cada nota\n- el `hash` del nodo\n\n> lo demás es ruido\n\n```ts\nconst ttl = 7 * 24 * 60\n```\nHecho. ~~olvidalo~~ no, quedó guardado.",
  )
  process.stdin.emit("data", Buffer.from("/s"))
}, 0)

setTimeout(() => {
  ;(process.stdout as any).write = realWrite
  draw(captured)
}, 60)

function draw(s: string): void {
  const grid: string[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => " "))
  let cr = 0
  let cc = 0
  const AN = /^\x1b\[([0-9;?]*)([A-Za-z])/
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = AN.exec(s.slice(i))
      if (m) {
        const params = m[1] ?? ""
        const final = m[2]!
        if (final === "H" || final === "f") {
          const nums = params.split(";").map((x) => parseInt(x || "1", 10))
          cr = (nums[0] ?? 1) - 1
          cc = (nums[1] ?? 1) - 1
        } else if (final === "A") cr -= parseInt(params || "1", 10)
        else if (final === "B") cr += parseInt(params || "1", 10)
        else if (final === "C") cc += parseInt(params || "1", 10)
        else if (final === "D") cc -= parseInt(params || "1", 10)
        else if (final === "K") {
          for (let x = cc; x < COLS; x++) if (grid[cr]) grid[cr]![x] = " "
        } else if (final === "J") {
          for (let y = cr; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y]) grid[y]![x] = " "
        }
        i += m[0].length
        continue
      }
      i++
      continue
    }
    const ch = s[i]!
    if (ch === "\n") {
      cr++
      cc = 0
      i++
      continue
    }
    if (ch === "\r") {
      cc = 0
      i++
      continue
    }
    if (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS) grid[cr]![cc] = ch
    cc++
    i++
  }
  const out = grid.map((row) => row.join("").replace(/\s+$/, ""))
  while (out.length && out[out.length - 1] === "") out.pop()
  console.log(out.join("\n"))
}
