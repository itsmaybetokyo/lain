import { createServer } from "node:http"
import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { LAIN_DIR, ensureDir } from "../config.js"
import { C, paint } from "../theme.js"
import { scoreEntry, type PublishRequest, type WireEntry, type NodeInfo } from "./protocol.js"

interface Store {
  entries: WireEntry[]
  nodes: NodeInfo[]
}

const STORE = join(LAIN_DIR, "wired.json")

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE, "utf8")) as Store
  } catch {
    return { entries: [], nodes: [] }
  }
}

function save(store: Store): void {
  ensureDir(LAIN_DIR)
  writeFileSync(STORE, JSON.stringify(store, null, 2), "utf8")
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c: Buffer) => (data += c.toString("utf8")))
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

/** Levanta el relay de la Wired (el índice global de conocimiento). */
export function startWiredRelay(port = 7777): Promise<{ close: () => Promise<void>; url: string }> {
  const store = load()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(obj))
    }

    try {
      if (url.pathname === "/health") {
        return json(200, {
          ok: true,
          name: "wired",
          protocol: 7,
          entries: store.entries.length,
          nodes: store.nodes.length,
        })
      }

      if (url.pathname === "/publish" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as PublishRequest
        const incoming = body.entries ?? []
        let added = 0
        const hashes = new Set(store.entries.map((e) => e.hash))
        for (const e of incoming) {
          if (hashes.has(e.hash)) continue
          store.entries.push(e)
          hashes.add(e.hash)
          added++
        }
        const now = new Date().toISOString()
        const node = store.nodes.find((n) => n.nodeId === body.nodeId)
        const count = store.entries.filter((e) => e.nodeId === body.nodeId).length
        if (node) {
          node.entries = count
          node.lastSeen = now
          node.handle = body.handle
        } else {
          store.nodes.push({ nodeId: body.nodeId, handle: body.handle, entries: count, lastSeen: now })
        }
        save(store)
        return json(200, { ok: true, added, total: store.entries.length })
      }

      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? ""
        const limit = Number(url.searchParams.get("limit") ?? 25)
        const results = store.entries
          .map((e) => ({ e, s: scoreEntry(e, q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit)
          .map((x) => x.e)
        return json(200, { ok: true, query: q, count: results.length, results })
      }

      if (url.pathname === "/entries") {
        return json(200, { ok: true, entries: store.entries })
      }

      if (url.pathname === "/nodes") {
        return json(200, { ok: true, nodes: store.nodes })
      }

      return json(404, { ok: false, error: "not found" })
    } catch (err) {
      return json(400, { ok: false, error: (err as Error).message })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      // Con port 0 el sistema elige uno libre: usamos el puerto real, no el pedido.
      const addr = server.address()
      const real = typeof addr === "object" && addr ? addr.port : port
      const url = `http://127.0.0.1:${real}`
      console.log(
        `\n${paint(C.brmagenta, "▓▒░")} ${paint(C.bold + C.brcyan, "the wired")} ${paint(
          C.gray,
          ":: relay escuchando",
        )}`,
      )
      console.log(`  ${paint(C.gray, "url")}   ${paint(C.brcyan, url)}`)
      console.log(`  ${paint(C.gray, "nodos")} ${store.nodes.length}   ${paint(C.gray, "entradas")} ${store.entries.length}`)
      console.log(`  ${paint(C.dim, "protocolo 7 · cada nodo guarda lo suyo; aquí se reúne todo y de cada uno")}\n`)
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())), url })
    })
  })
}
