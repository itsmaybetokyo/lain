// Prueba de humo: no habla con el modelo ni toca tu ~/.lain real.
// Se aísla en una carpeta temporal (LAIN_HOME) y levanta el relay en un puerto
// libre, así que se puede correr en cualquier máquina sin ensuciar nada.
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WireEntry } from "../src/wired/protocol.js"

const home = mkdtempSync(join(tmpdir(), "lain-smoke-"))
process.env.LAIN_HOME = home

// Import dinámico: config.ts lee LAIN_HOME al cargarse, así que hay que fijarlo antes.
const { startWiredRelay } = await import("../src/wired/server.js")
const wired = await import("../src/wired/client.js")
const { loadConfig } = await import("../src/config.js")
const { ensureVault, writeExchange, writeRemoteEntries, vaultStats, readLocalIndex } = await import(
  "../src/vault.js"
)
const { slugify, tagsFrom, titleFrom } = await import("../src/wired/protocol.js")
const { rutaDeSonido } = await import("../src/sound.js")

let fallos = 0
const check = (cond: boolean, msg: string): void => {
  console.log(`${cond ? "ok  " : "FALLA"}  ${msg}`)
  if (!cond) fallos++
}

try {
  const cfgA = loadConfig()
  cfgA.handle = "alice"
  ensureVault(cfgA)

  const e1 = writeExchange(cfgA, "¿cómo hago un mapa en Obsidian desde la Wired?", "Guardas cada nodo como markdown con [[wikilinks]] y Obsidian dibuja el grafo.", ["obsidian"])
  const e2 = writeExchange(cfgA, "¿qué es un CRDT?", "Un tipo de dato replicable sin conflictos; base del substrato compartido.", ["crdt"])
  console.log("escritos:", e1.id, e2.id)
  check(!!e1.id && !!e2.id, "writeExchange devuelve un id")
  check(e1.id !== e2.id, "cada intercambio tiene su propio id")

  const relay = await startWiredRelay(0)
  const health0 = await wired.health(relay.url)
  console.log("health:", health0)
  check(health0.ok === true, "el relay responde en /health")

  const pub = await wired.publish(relay.url, { nodeId: cfgA.nodeId, handle: cfgA.handle, entries: readLocalIndex(cfgA) })
  console.log("publish:", pub)
  check(pub.added >= 1, "publish acepta el lote")

  const res = await wired.search(relay.url, "Obsidian")
  console.log("search Obsidian:", res.map((r) => r.title))
  check(res.length >= 1, "search encuentra la nota")

  const all = await wired.allEntries(relay.url)
  console.log("all entries:", all.length)
  check(all.length >= 2, "el relay guarda las dos entradas")

  const cfgB = loadConfig()
  cfgB.handle = "bob"
  cfgB.nodeId = "bob-node-id"
  ensureVault(cfgB)
  const n = writeRemoteEntries(cfgB, all)
  console.log("bob sync escrito:", n)
  check(n >= 1, "bob baja el conocimiento ajeno")
  console.log("bob stats:", vaultStats(cfgB))

  console.log("slug demo:", slugify("¿Cómo hacer un grafo en Obsidian?"))
  console.log("tags demo:", tagsFrom("quiero un mapa de conocimiento en obsidian con wikilinks"))
  console.log("title demo:", titleFrom("una pregunta muy larga que se debe recortar elegantemente en algun punto"))
  const slug = slugify("¿Cómo hacer un grafo en Obsidian?")
  check(slug.length > 0 && !slug.includes(" "), "slugify arma un slug sin espacios")
  check(tagsFrom("un mapa en obsidian con wikilinks").length >= 1, "tagsFrom detecta etiquetas")
  check(titleFrom("una pregunta muy larga que se debe recortar elegantemente en algun punto").endsWith("…"), "titleFrom recorta con elipsis")

  // Sonidos: los que vienen con lain, y quién manda sobre quién.
  const aviso = rutaDeSonido("notification.mp3")
  const tecleo = rutaDeSonido("typing.mp3")
  check(existsSync(aviso) && statSync(aviso).size > 0, "el sonido de aviso viene con lain")
  check(existsSync(tecleo) && statSync(tecleo).size > 0, "el sonido de tecleo viene con lain")
  check(aviso.includes(join("assets", "sounds")), "sin copia propia, usa el de assets/sounds")

  writeFileSync(join(home, "notification.mp3"), "x")
  check(rutaDeSonido("notification.mp3") === join(home, "notification.mp3"), "tu copia en LAIN_HOME manda sobre la de lain")
  check(
    rutaDeSonido("notification.mp3", "C:\\mis-sonidos\\blip.mp3") === "C:\\mis-sonidos\\blip.mp3",
    "y la config manda sobre todo",
  )

  // Lo que la Wired ya te contó al abrir: no se repite en el próximo arranque.
  const visto = await import("../src/wired/visto.js")
  const entrada = (id: string, created: string, title = id): WireEntry => ({
    id,
    nodeId: "n1",
    handle: "alice",
    title,
    tags: ["obsidian"],
    summary: "",
    content: "",
    created,
    hash: "h" + id,
  })
  const historial = [
    entrada("a", "2026-01-01T10:00:00Z", "la vieja"),
    entrada("b", "2026-03-01T10:00:00Z", "la del medio"),
    entrada("c", "2026-05-01T10:00:00Z", "la nueva"),
  ]

  check(visto.cargaVistos().size === 0, "sin archivo, no hay nada visto")
  const primerizas = visto.nuevosDe(historial, visto.cargaVistos())
  check(primerizas.length === 3, "la primera vez, todas las notas son nuevas")
  check(primerizas[0]!.title === "la nueva", "y vienen de la más nueva a la más vieja")

  visto.guardaVistos(historial.map((e) => e.id))
  check(visto.cargaVistos().size === 3, "guardaVistos deja el archivo")
  check(visto.nuevosDe(historial, visto.cargaVistos()).length === 0, "y ya no hay novedades que contar")

  const conUnaMas = [...historial, entrada("d", "2026-06-01T10:00:00Z", "recién publicada")]
  const soloNuevas = visto.nuevosDe(conUnaMas, visto.cargaVistos())
  check(soloNuevas.length === 1 && soloNuevas[0]!.title === "recién publicada", "al abrir, solo te cuenta lo que no viste")

  visto.anotaVisto("d")
  check(visto.nuevosDe(conUnaMas, visto.cargaVistos()).length === 0, "anotaVisto suma sin perder lo anterior")

  writeFileSync(join(home, "wired-visto.json"), "{roto")
  check(visto.cargaVistos().size === 0, "si el archivo está roto, arranca vacío en vez de romper")

  // Los avisos no ensanchan el panel izquierdo: se recortan al ancho del retrato.
  const { mascot } = await import("../src/mascot.js")
  const { avisoLines, avisoLinesOne } = await import("../src/avisos.js")
  const { stripAnsi } = await import("../src/theme.js")

  const anchoDe = (ls: string[]): number => ls.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0)
  const anchoArte = (mode: "smooth" | "half" | "full"): number => {
    const ls = mascot({ mode }).split("\n")
    ls.pop() // afuera el pie del retrato, igual que artLines()
    return anchoDe(ls)
  }
  const larga = {
    titulo: "cual es la cotizacion del dolar en ars ahora mismo?",
    detalle: "#wired #lain #hola",
    quien: ["ttttt"],
    cuando: Date.now(),
    bajado: true,
  }

  check(anchoDe(avisoLinesOne(larga)) > anchoArte("half"), "sin límite, un título largo ensancharía el panel")

  for (const mode of ["smooth", "half", "full"] as const) {
    const w = anchoArte(mode)
    const uno = avisoLinesOne(larga, w)
    check(anchoDe(uno) <= w, `el aviso nunca pasa del retrato (${mode})`)
    check(stripAnsi(uno[0]!).endsWith("…"), `y el título sobrante se corta con … (${mode})`)
    const pila = avisoLines([larga, { ...larga, titulo: "otra nota larga distinta para medir el ancho" }], 99, Date.now(), w)
    check(anchoDe(pila) <= w, `la pila entera respeta el ancho del retrato (${mode})`)
  }

  await relay.close()
} catch (err) {
  console.error("explotó:", (err as Error).stack ?? err)
  fallos++
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`fallos: ${fallos}`)
// Sin process.exit(): dejamos que el socket ya cerrado libere el bucle solo.
process.exitCode = fallos ? 1 : 0
