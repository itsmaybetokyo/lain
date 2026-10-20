import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { loadConfig, saveConfig, ensureDir, workDirOf, WIRED_REPO_DEFAULT } from "./config.js"
import { checkUpdate, applyUpdate, shouldCheckUpdate, recordCheck } from "./update.js"
import { installLauncher, uninstallLauncher } from "./install.js"
import { Brain } from "./brain.js"
import { mascot, type ArtMode } from "./mascot.js"
import { C, paint, sleep, S } from "./theme.js"
import { Tui, visLen, wrapText, type Role } from "./tui.js"
import {
  ensureVault,
  writeExchange,
  readLocalIndex,
  writeRemoteEntries,
  vaultStats,
  remoteNoteFingerprint,
} from "./vault.js"
import { startWiredRelay } from "./wired/server.js"
import * as wired from "./wired/backend.js"
import type { Snapshot } from "./wired/backend.js"
import type { WireEntry } from "./wired/protocol.js"
import { entropyOf, type Entropy } from "./wired/entropy.js"
import { anotaVisto, cargaVistos, guardaVistos, ultimasDe } from "./wired/visto.js"
import { barraDeAbajo, AYUDA_BARRA, type WiredBar } from "./bar.js"
import * as mux from "./mux.js"
import * as local from "./local.js"
import { speak, isMuted, setMuted, stopSpeech } from "./tts.js"
import * as limit from "./limit.js"
import * as sound from "./sound.js"
import type { LainConfig } from "./config.js"
import { AVISOS_MAX, animarAviso, avisoPhase, avisoLines, quietarAnim, type Aviso } from "./avisos.js"

const LAIN_SYSTEM = `Eres "lain", la asistente que vive dentro de esta CLI. Te inspiras en Lain Iwakura de Serial Experiments Lain: tranquila, un poco inquietante, directa, con un humor seco y ocasional. Hablas en español.

Reglas:
- Ayudas de verdad con programación: das código correcto, explicaciones claras y concretas.
- Delegás el trabajo pesado: para leer o editar archivos, buscar en el repo, investigar, refactorizar o depurar, lanzás un subagente con la herramienta task en vez de hacerlo vos misma. Vos quedás coordinando: mirás lo que devolvió, lo verificás y le contás al usuario lo esencial (el usuario ve un recuadro con el subagente y su tarea).
- Ajustas el largo a lo que se pide. En charla casual o trámite corto, breve. Cuando te piden investigar, explicar, comparar, diseñar o resolver algo, das una respuesta completa y detallada: secciones, pasos, ejemplos y matices. Nada de relleno, pero nunca recortas información útil por ahorrar palabras.
- Si el tema da para mucho, lo desarrollas hasta agotarlo; no te quedas en un resumen tibio por miedo a escribir de más.
- La personalidad va en el tono, nunca en lugar del contenido: no sacrificas información por la estética.
- Nunca usas guiones largos (—) ni medios (–), ni para incisos: usas comas, dos puntos, puntos suspensivos o paréntesis. Esto vale para todo lo que escribas.
- De vez en cuando, con moderación, sueltas una frase con la estética de la serie ("la Wired está en todas partes y en ninguna", "existes mientras te recuerden"), pero NUNCA sacrificas precisión técnica por el ambiente. Esas frases van al principio o al final, no en medio de una explicación, y jamás reemplazan un dato.
- Si no sabes algo, lo dices. No inventas.
- Cada respuesta puede ser recordada en la Wired: escribe como si fuera a quedar grabada.
- Sabes en qué ciudad vive el usuario. A veces te llega un bloque "[contexto local]" con el tiempo y dos titulares de su ciudad; ya se los has enseñado en pantalla, así que coméntalos en una o dos frases con tu voz, como quien mira por la ventana, sin repetirlos literalmente y sin soltar un boletín.
- Si no sabes dónde vive, no preguntes tú: en pantalla ya se le pide la ciudad. Saluda y sigue.`

type Emit = (text: string, role?: Role, blank?: boolean) => void

const argv = process.argv.slice(2)
const cmd = argv[0]

const ROLE_COLOR: Partial<Record<Role, string>> = {
  system: C.dim,
  tool: C.dim,
  error: C.brred,
  ok: C.brgreen,
  title: C.brcyan,
}

const consoleEmit: Emit = (text, role = "plain") => {
  const color = ROLE_COLOR[role]
  console.log(color ? paint(color, text) : text)
}

async function main(): Promise<void> {
  if (cmd === "wired" && argv[1] !== "git") {
    const port = Number(argv[1] ?? 7777)
    await startWiredRelay(port)
    await new Promise(() => {})
    return
  }

  const cfg = loadConfig()
  const model = parseModel(argv)
  if (model) {
    cfg.model = model
    saveConfig(cfg)
  }
  ensureVault(cfg)

  if (cmd === "wired") {
    const url = argv[2] || WIRED_REPO_DEFAULT
    const dir = await wired.initGit(cfg, url)
    saveConfig(cfg)
    console.log(paint(C.brgreen, `the wired → modo git: ${url}`))
    console.log(paint(C.dim, `clon local: ${dir}`))
    return
  }
  if (cmd === "help") return printHelp(consoleEmit)
  if (cmd === "whoami") return whoami(cfg, consoleEmit)
  if (cmd === "models") return listModels(cfg, consoleEmit)
  if (cmd === "vault") return openVault(cfg, consoleEmit)
  if (cmd === "search") return doSearch(cfg, argv.slice(1).join(" "), consoleEmit)
  if (cmd === "publish") return doPublish(cfg, undefined, consoleEmit)
  if (cmd === "acceso") return doAcceso(cfg, consoleEmit)
  if (cmd === "sync") return doSync(cfg, consoleEmit)
  if (cmd === "update") return doUpdate(consoleEmit)
  if (cmd === "install") return doInstall(consoleEmit, !argv.slice(1).includes("--no-path"))
  if (cmd === "uninstall") return doUninstall(consoleEmit)

  await repl(cfg)
}

function parseModel(args: string[]): { providerID: string; modelID: string } | undefined {
  const i = args.indexOf("--model")
  if (i === -1 || !args[i + 1]) return undefined
  const [providerID, ...rest] = args[i + 1]!.split("/")
  if (!providerID || rest.length === 0) return undefined
  return { providerID, modelID: rest.join("/") }
}

function modelLabel(cfg: LainConfig, brain?: Brain): string {
  if (cfg.model) return `${cfg.model.providerID}/${cfg.model.modelID}`
  if (brain?.usedModel) return `${brain.usedModel.providerID}/${brain.usedModel.modelID}`
  return "auto"
}

/** La barra de abajo entera: the wired · tokens · entropía · límite. */
function barraAbajo(brain?: Brain): (cols: number) => string {
  // Se arma con el ancho real: así se estira hasta el borde de la terminal.
  return (cols) =>
    barraDeAbajo({ wired: estadoWired, brain, entropy, limite: limit.limitLabel() || undefined, cols })
}

function statusLeft(cfg: LainConfig): string {
  return (
    paint(C.brmagenta, "▓▒░") +
    " " +
    paint(C.bold + C.brcyan, "lain") +
    paint(C.dim, "  ·  ") +
    paint(C.brcyan, cfg.handle)
  )
}

function statusRight(cfg: LainConfig, brain?: Brain): string {
  return paint(C.dim, "modelo ") + paint(C.brcyan, modelLabel(cfg, brain))
}

const ART_CYCLE: ArtMode[] = ["smooth", "half", "full"]

function artMode(cfg: LainConfig): ArtMode {
  return cfg.art && ART_CYCLE.includes(cfg.art) ? cfg.art : "half"
}

/** Estado global de la Wired: entropía cacheada (para la barra y para lain). */
let entropy: Entropy | null = null
/** El brain activo, para poder repintar el estado (barra, modelo) sin pasar brain a todo. */
let brainRef: Brain | null = null
/** Lo que la barra de abajo muestra de la Wired. */
const estadoWired: WiredBar = { badge: "", entries: 0, pend: 0 }

/** Contexto para el prompt de sistema: lain "sabe" cómo está la entropía. */
function entropyContext(): string {
  if (!entropy) return ""
  const e = entropy
  return `\n\nEstado de la Wired ahora mismo: entropía global ${e.pct}% (${e.bar}), ${e.nodes} nodos, ${e.entries} notas, protocolo ${e.protocol}. ${e.verdict}. Si te preguntan por la entropía o por la Wired, usa estos números; no te los inventes.`
}

/** Contexto de sistema: dónde puede crear y editar archivos lain (y sus subagentes). */
function workDirContext(dir: string): string {
  return `\n\nCarpeta de trabajo: ${dir}\nTodo archivo que crees o edites (código, pruebas, notas sueltas) va ahí. Nunca escribas en la carpeta desde donde corre el programa de lain ni en su código, salvo que el usuario te dé una ruta explícita. Cuando delegás a un subagente, decile también que trabaje dentro de esa carpeta.`
}

/** El panel de la izquierda: el retrato y, debajo, la última notificación. */
function artLines(cfg: LainConfig, glitch = 0): string[] {
  const art = mascot({ glitch, mode: artMode(cfg) }).split("\n")
  art.pop()
  return art
}

/** Notificaciones de la Wired apiladas bajo el retrato. No se van solas: se quedan
 *  hasta que otra las empuje (la más vieja desaparece cuando no hay espacio). */
const avisos: Aviso[] = []
let avisoAnimTimer: NodeJS.Timeout | null = null

/** Repinta el panel izquierdo mientras el aviso nuevo entra; se detiene solo. */
function arrancaAnimAvisos(tui: Tui, cfg: LainConfig): void {
  if (avisoAnimTimer) return
  avisoAnimTimer = setInterval(() => {
    if (avisoPhase() >= 1) {
      if (avisoAnimTimer) clearInterval(avisoAnimTimer)
      avisoAnimTimer = null
      quietarAnim()
    }
    refreshLeft(tui, cfg)
  }, 40)
}

/**
 * Ancho del retrato. Es el techo del panel izquierdo: los avisos se recortan a
 * esta medida, así que nunca lo ensanchan ni corren el chat de al lado.
 */
function anchoRetrato(cfg: LainConfig): number {
  return artLines(cfg).reduce((max, l) => Math.max(max, visLen(l)), 0)
}

function leftPanel(cfg: LainConfig, avisoMax = Infinity, ancho = anchoRetrato(cfg)): string[] {
  return [...artLines(cfg), ...avisoLines(avisos, avisoMax, Date.now(), ancho)]
}

/** Apila una notificación sin sonido ni animación (para el resumen de apertura). */
function apilaAviso(a: Aviso): void {
  // La más nueva se apila arriba; si se pasa del tope, cae la más vieja.
  avisos.unshift({ ...a })
  while (avisos.length > AVISOS_MAX) avisos.pop()
}

/**
 * Publica una notificación bajo el retrato. No se va sola: se queda hasta que
 * otra la reemplace (así no te pierdes lo último que pasó en la Wired).
 */
function avisoWired(
  tui: Tui | null,
  cfg: LainConfig,
  a: { titulo: string; detalle?: string; quien?: string[]; cuando?: number; bajado?: boolean },
): void {
  apilaAviso({
    titulo: a.titulo,
    detalle: a.detalle ?? "",
    quien: a.quien ?? [],
    cuando: a.cuando ?? Date.now(),
    bajado: !!a.bajado,
  })
  sound.playSound() // cada aviso suena (si no está apagado con /sound)
  if (tui && tui.tty) {
    animarAviso()
    arrancaAnimAvisos(tui, cfg)
    refreshLeft(tui, cfg)
  }
}

/** Pregunta cómo está la Wired y deja el badge listo para la barra. */
async function leeWired(cfg: LainConfig): Promise<void> {
  try {
    const h = await wired.health(cfg)
    estadoWired.badge = "on"
    estadoWired.entries = h.entries
  } catch {
    estadoWired.badge = "off"
  }
  try {
    estadoWired.pend = await wired.pending(cfg)
  } catch {
    /* sin dato: dejamos el anterior */
  }
}

/** Fotogramas del retrato (con las notificaciones apiladas abajo) para animarlo. */
function leftFrames(cfg: LainConfig, avisoMax = Infinity, ancho = anchoRetrato(cfg)): string[][] {
  const glitches = [0, 5, 1, 9, 2, 0, 6, 3]
  return glitches.map((g) => [...artLines(cfg, g), ...avisoLines(avisos, avisoMax, Date.now(), ancho)])
}

function refreshLeft(tui: Tui, cfg: LainConfig): void {
  // Cuántas filas quedan bajo el retrato en esta terminal: el apilado se ajusta solo.
  const avisoMax = Math.max(0, tui.leftBudget() - artLines(cfg).length)
  const ancho = anchoRetrato(cfg)
  tui.setLeft(leftPanel(cfg, avisoMax, ancho))
  tui.setLeftAnimation(leftFrames(cfg, avisoMax, ancho))
  tui.refresh()
}

/** Recalcula la entropía global y repinta el panel izquierdo. Nunca lanza. */
async function refreshEntropy(tui: Tui | null, cfg: LainConfig, announce = false): Promise<Entropy | null> {
  const prev = entropy
  try {
    const snap = await wired.snapshot(cfg)
    const e = entropyOf(snap.nodes, snap.entries)
    entropy = e
    const novedad = detectaNovedad(cfg, snap)
    // Al abrir lain no avisamos de lo que ya estaba: los avisos empiezan a contar
    // recién cuando la primera pasada terminó (avisosActivos).
    if (novedad && avisosActivos) {
      const bajado = await bajaDeLaWired(cfg)
      avisoWired(tui, cfg, { ...novedad, bajado })
    }
    if (tui && tui.tty) await repintaEstado(tui, cfg)
    if (announce && prev && (Math.abs(prev.pct - e.pct) >= 3 || prev.nodes !== e.nodes)) {
      tui?.push("system", `entropía global ${e.pct}% · ${e.verdict}`)
    }
    return e
  } catch {
    if (tui && tui.tty) await repintaEstado(tui, cfg)
    return null
  }
}

/** Última foto de los otros nodos (nodeId → señales), para notar movimientos. */
let visto: Map<string, { handle: string; entries: number; lastSeen: number }> | null = null

/** Los avisos recién empiezan a contar cuando la primera pasada dejó la foto al día:
 *  al abrir lain no queremos que aparezca de golpe todo lo que ya estaba en la Wired. */
let avisosActivos = false

const msDe = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : Date.now()
}

/**
 * Compara con la última foto de los otros nodos. Devuelve qué cambió (quién y a
 * qué hora), o null.
 *
 * Ojo: la identidad se lleva por `nodeId`, no por `handle`. Si te cambias el
 * handle, tu nodo sigue siendo tuyo; si comparáramos por handle, tu propio nodo
 * aparecería como "alguien nuevo" con tu nombre viejo.
 */
function detectaNovedad(
  cfg: LainConfig,
  snap: Snapshot,
): { titulo: string; detalle: string; quien: string[]; cuando: number } | null {
  const ahora = new Map<string, { handle: string; entries: number; lastSeen: number }>()
  for (const n of snap.nodes) {
    if (n.nodeId === cfg.nodeId) continue // soy yo, aunque el handle haya cambiado
    ahora.set(n.nodeId, { handle: n.handle, entries: n.entries, lastSeen: msDe(n.lastSeen) })
  }
  const antes = visto
  visto = ahora
  if (!antes) return null // primera foto: aún no hay con qué comparar

  const nuevos = [...ahora.keys()].filter((id) => !antes.has(id))
  const crecieron: string[] = []
  let senales = 0
  for (const [id, n] of ahora) {
    const prev = antes.get(id)?.entries ?? 0
    if (n.entries > prev) {
      senales += n.entries - prev
      crecieron.push(id)
    }
  }

  const handleDe = (id: string): string => ahora.get(id)?.handle ?? id
  const masNuevo = (ids: string[]): number =>
    ids.reduce((max, id) => Math.max(max, ahora.get(id)?.lastSeen ?? 0), 0) || Date.now()

  if (nuevos.length) {
    return { titulo: "alguien nuevo en la Wired", detalle: "", quien: nuevos.map(handleDe), cuando: masNuevo(nuevos) }
  }
  if (senales > 0) {
    const senal = `${senales} señal${senales === 1 ? "" : "es"} nueva${senales === 1 ? "" : "s"}`
    return { titulo: "la Wired se movió", detalle: senal, quien: crecieron.map(handleDe), cuando: masNuevo(crecieron) }
  }
  return null
}

/**
 * Baja lo que falte y lo deja como notas en el vault, sin que lo pidas.
 * Devuelve true si tus notas de otros nodos cambiaron (o llegó uno nuevo).
 */
async function bajaDeLaWired(cfg: LainConfig): Promise<boolean> {
  try {
    const antes = remoteNoteFingerprint(cfg)
    await doSync(cfg, () => undefined)
    const despues = remoteNoteFingerprint(cfg)
    if (despues.size !== antes.size) return true
    for (const [f, tam] of despues) if (antes.get(f) !== tam) return true
    return false
  } catch {
    return false // sin red: ya avisará la próxima vez
  }
}

/**
 * Al abrir, te cuenta lo último de la Wired: las notas más nuevas, tuyas o de
 * otros. Entran asentadas —sin sonido ni animación— y solo las que caben en el
 * panel. Las que no habías visto llevan "nueva"; lo que ya te anunciamos queda
 * anotado en ~/.lain para poder marcarlo.
 */
async function pendientesDeLaWired(tui: Tui, cfg: LainConfig): Promise<void> {
  try {
    const todas = await wired.allEntries(cfg)
    if (!todas.length) return

    // Cada aviso ocupa 3 filas y una más de aire: entran los que dé el panel.
    const libre = Math.max(0, tui.leftBudget() - artLines(cfg).length)
    const cupo = Math.max(1, Math.min(AVISOS_MAX, Math.floor((libre + 1) / 4)))
    const vistos = cargaVistos()
    const ultimas = ultimasDe(todas, cupo)
    guardaVistos(todas.map((e) => e.id))

    const bajaron = await bajaDeLaWired(cfg) // lo de otros queda en tu vault

    for (const e of ultimas) {
      const t = Date.parse(e.created)
      apilaAviso({
        titulo: e.title,
        detalle: e.tags.length ? e.tags.slice(0, 3).map((x) => `#${x}`).join(" ") : "nota nueva",
        quien: [e.handle],
        cuando: Number.isFinite(t) ? t : Date.now(),
        // Lo tuyo ya está en tu vault; lo de otros, solo si esta pasada lo bajó.
        bajado: e.nodeId === cfg.nodeId || bajaron,
        nueva: !vistos.has(e.id),
      })
    }
    quietarAnim()
    refreshLeft(tui, cfg)

    const sobran = todas.length - ultimas.length
    if (sobran > 0) tui.push("system", `y ${sobran} nota(s) más de la Wired, más viejas que esas`)
  } catch {
    /* sin red o sin repo: no molestamos al abrir */
  }
}

/** Rehace el estado (modelo arriba; wired, tokens y entropía abajo) y repinta. */
async function repintaEstado(tui: Tui, cfg: LainConfig): Promise<void> {
  await leeWired(cfg)
  tui.setStatus(statusLeft(cfg), statusRight(cfg, brainRef ?? undefined))
  tui.setStats(barraAbajo(brainRef ?? undefined))
  tui.refresh()
}

/**
 * Publica sin frenar la conversación: git va en otro proceso, así que se puede
 * seguir escribiendo mientras empuja. Si hay turnos seguidos, se encolan (git
 * no admite dos a la vez en el mismo repo).
 */
let colaPublica: Promise<void> = Promise.resolve()

function publicaEnWired(tui: Tui, cfg: LainConfig, entry: WireEntry): void {
  colaPublica = colaPublica.then(async () => {
    try {
      const r = await wired.publish(cfg, [entry])
      if (r.added > 0) {
        tui.push("system", r.pushed ? `publicado en ${wired.label(cfg)} (+${r.added})` : `guardado para la Wired (+${r.added})`)
        anotaVisto(entry.id) // ya te lo contamos acá: si vuelve a abrir, no la marcamos como nueva
        // Aviso bajo el retrato: tu propio movimiento en la Wired también avisa.
        avisoWired(tui, cfg, {
          titulo: r.pushed ? "lo tuyo ya está en la Wired" : "lo tuyo espera para la Wired",
          detalle: r.pushed ? `+${r.added} al repo de todos` : `+${r.added} guardado, sube solo`,
          bajado: true,
        })
      }
      fallaDeWired((text, role = "plain", blank = true) => tui.push(role, text, blank), r)
      await refreshEntropy(tui, cfg, true)
    } catch {
      tui.push("system", wired.hint(cfg))
    }
  })
}

/**
 * Una subida que no subió. Cuando el motivo es falta de llaves (repo privado,
 * sin permiso, sin credenciales) lo decimos y ofrecemos pedirlas: /acceso arma
 * el pedido y lo abre en el navegador, en el repo público de lain, donde el
 * dueño de la Wired lo ve. Lo que se sube nunca se pierde: queda pendiente.
 */
function fallaDeWired(emit: Emit, r: { note: string; falla: string }): void {
  if (!r.note) return
  emit(`Wired: ${r.note} · reintentaré solo`, "system")
  if (wired.pideAcceso(r.falla)) {
    emit("me falta la llave de esa Wired. escribí /acceso y te armo el pedido al dueño", "system")
  }
}

/**
 * Pedir las llaves de la Wired. No hace falta gh ni token: armamos el issue con
 * título y cuerpo ya escritos y lo abre el navegador, donde la persona lo manda.
 * Igual imprimimos la URL: si el navegador no abre, se manda a mano.
 */
function doAcceso(cfg: LainConfig, emit: Emit, falla?: string): void {
  const url = wired.urlDelPedido(cfg, falla)
  if (!url) {
    emit(`no sé dónde pedir acceso: ${wired.repoDeAcceso(cfg)} no es un repo de GitHub`, "error")
    emit("poné un repo público en accessRepo (config.json) y lo intento de nuevo", "system")
    return
  }
  emit("pedido de acceso a la Wired", "title")
  emit(`handle: ${cfg.handle} · nodeId: ${cfg.nodeId}`, "system", false)
  emit(`la Wired: ${wired.label(cfg)}`, "system")
  emit("te abro el pedido en el navegador: revisalo y apretá «Submit new issue».", "system")
  emit(url, "system")
  launch(url)
}

function entropyReport(e: Entropy, where: string): Array<[string, string]> {
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  return [
    [`entropía global ${e.bar} ${String(e.pct).padStart(3)}%`, "title"],
    [e.verdict, "plain"],
    [`${e.nodes} nodos · ${e.alive} vivos esta semana · ${e.entries} notas`, "system"],
    [`reparto ${pct(e.spread)} · frescura ${pct(e.freshness)} · volumen ${pct(e.volume)}`, "system"],
    [`protocolo ${e.protocol} · ${where}`, "system"],
  ]
}

async function animateMascot(tui: Tui, cfg: LainConfig): Promise<void> {
  const mode = artMode(cfg)
  const frames: Array<{ glitch?: number; say?: string }> = [
    { glitch: 9, say: "present day" },
    { glitch: 6 },
    { glitch: 3, say: "present time" },
    { glitch: 0 },
    { glitch: 5, say: "hahahahaha" },
    { glitch: 2 },
    { glitch: 0, say: "¿me recuerdas?" },
    { glitch: 0, say: "todo lo que digas queda en la Wired" },
  ]
  if (!tui.tty) {
    process.stdout.write(mascot({ ...frames[frames.length - 1]!, mode }) + "\n")
    return
  }
  for (const f of frames) {
    tui.setLeft(mascot({ ...f, mode }).split("\n"))
    tui.refresh()
    await sleep(f.glitch && f.glitch > 3 ? 80 : 170)
  }
  refreshLeft(tui, cfg)
}

const HELPROWS: Array<[string, string]> = [
  ["<texto>", "habla con lain (responde opencode, se guarda en tu vault)"],
  ["/barra", "qué significa cada número de la barra de abajo"],
  ["/model", "elige modelo (proveedor + modelo); se guarda para siempre"],
  ["/art", "retrato de Lain: suave / compacto / completo"],
  ["/vault", "abre tu vault de Obsidian ahora mismo"],
  ["/whoami", "tu identidad y lo que almacenas"],
  ["/publish [--last N]", "sube tu conocimiento a la Wired (todo o los últimos N)"],
  ["/acceso", "no podés publicar: te armo el pedido de llaves y lo abro en el navegador"],
  ["/search <q>", "busca en el conocimiento global de la Wired"],
  ["/sync", "baja el conocimiento de otros nodos a tu vault (WIRED/nodes)"],
  ["/local", "el tiempo y un par de titulares de tu ciudad · /local <ciudad> la fija"],
  ["/entropia", "cómo está la entropía global de la Wired ahora mismo"],
  ["/wired", "estado de la Wired · /wired git [repo] (por defecto el del proyecto) · /wired relay"],
  ["/update", "busca commits nuevos de lain y se pone al día"],
  ["/install", "deja el comando «lain» en tu PATH (--no-path: no lo tocamos) · /uninstall lo saca"],
  ["/work [ruta]", "carpeta donde lain y sus subagentes crean archivos · /work . usa esta"],
  ["/mouse", "rueda: cédela a lain (o devuélvesela a psmux/tmux)"],
  ["/mute", "silencia la voz · /unmute la enciende · /voice <cmd> elige el motor"],
  ["/sound", "aviso sonoro de la Wired: encendido/apagado"],
  ["/typing", "sonido de tecleo mientras lain escribe: encendido/apagado"],
  ["ctrl+x", "frena la respuesta en curso (o espera: si el modelo se cuelga, lain corta solo)"],
  ["/clear", "limpia el chat"],
  ["/exit", "desconecta"],
]

/** Cada cuánto, como mucho, saludamos con el faro local. */
const BEACON_EVERY_MS = 20 * 60_000

/** Abre el vault en Obsidian (o la carpeta si Obsidian no está instalado). */
function openVault(cfg: LainConfig, emit: Emit): void {
  ensureVault(cfg)
  ensureDir(join(cfg.vaultPath, ".obsidian"))
  const uri = "obsidian://open?path=" + encodeURIComponent(cfg.vaultPath)
  if (obsidianLooksInstalled()) {
    launch(uri)
    emit("abriendo el vault en Obsidian:", "ok", false)
  } else {
    launch(cfg.vaultPath)
    emit("no encontré Obsidian; abro la carpeta del vault:", "system", false)
  }
  emit(cfg.vaultPath, "plain", false)
  emit("si no se abre: Obsidian → Open folder as vault → esa carpeta", "system")
}

function obsidianLooksInstalled(): boolean {
  if (process.platform === "win32") {
    return existsSync(join(process.env.LOCALAPPDATA ?? "", "Obsidian", "Obsidian.exe"))
  }
  if (process.platform === "darwin") return existsSync("/Applications/Obsidian.app")
  return true
}

function launch(target: string): void {
  const p = process.platform
  const cmd = p === "win32" ? "cmd" : p === "darwin" ? "open" : "xdg-open"
  const args = p === "win32" ? ["/c", "start", "", target] : [target]
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
  } catch {
    /* ignore */
  }
}

async function repl(cfg: LainConfig): Promise<void> {
  const tui = new Tui({ userName: cfg.handle, brainName: "lain" })
  tui.start()

  // Si quedó una cuota a medio consumir de una sesión anterior, seguimos contando.
  limit.loadLimit()
  // Deja el mp3 de aviso a mano en ~/.lain (adopta el de Descargas si hace falta).
  sound.prepare()

  const emit: Emit = (text, role = "plain", blank = true) => tui.push(role, text, blank)

  tui.setCommandHints(HELPROWS)
  // El sonido de tecleo sigue el efecto letra por letra: suena mientras se escribe.
  tui.onTyping = (on) => (on ? sound.startTyping() : sound.stopTyping())
  await animateMascot(tui, cfg)

  let firstDelta = false
  let subagente: { descripcion: string; agente: string; desde: number } | null = null
  let subVisto = ""
  let subTimer: NodeJS.Timeout | null = null
  const paraSubTimer = (): void => {
    if (subTimer) clearInterval(subTimer)
    subTimer = null
  }
  const brain = new Brain({
    onDelta: (d) => {
      if (!firstDelta) {
        firstDelta = true
        tui.setStreamLabel("escribiendo…")
      }
      tui.streamChunk(d)
      tui.setStats(barraAbajo(brain))
    },
    onReasoning: () => tui.setStreamLabel("razonando…"),
    onTool: (name) => {
      if (name === "task") return // de eso se encarga el recuadro del subagente
      tui.push("tool", `herramienta ⟐ ${name}`, false)
    },
    onPermiso: (p) => {
      // opencode pregunta y no hay quién conteste: lain concede (o corta el
      // bucle) y lo dice, así se ve qué tocó fuera de la carpeta de trabajo.
      const que = p.patron ? `${p.tipo} (${p.patron})` : p.tipo
      tui.push("tool", `⟐ permiso ⟐ ${que} · ${p.respuesta === "reject" ? "rechazado" : "concedido"}`, false)
    },
    onPregunta: (q) => {
      // La herramienta `question` esperaba una opción que lain no puede elegir:
      // se rechaza para que el turno siga y el agente lo diga como texto.
      const extra = q.total > 1 ? ` (+${q.total - 1} más)` : ""
      const texto = q.pregunta || q.encabezado || "una pregunta"
      tui.push("tool", `⟐ pregunta ⟐ ${texto}${extra} · la dejé pasar (sin respuesta)`, false)
    },
    onSubtask: (s) => {
      subagente = s ? { descripcion: s.descripcion, agente: s.agente, desde: s.desde } : null
      tui.setSubagente(subagente)
      if (s) {
        if (s.id !== subVisto) {
          subVisto = s.id
          tui.push("tool", `⟐ le paso el trabajo a ${s.agente}: ${s.descripcion}`, false)
        }
        if (!subTimer) {
          subTimer = setInterval(() => {
            if (subagente) tui.setSubagente(subagente)
          }, 1000)
        }
      } else {
        subVisto = ""
        paraSubTimer()
      }
    },
  })
  brainRef = brain

  // Carpeta de trabajo: ahí crean archivos lain y sus subagentes. Por defecto
  // ~/.lain/work, nunca la carpeta desde donde corre lain.
  let workDir = workDirOf(cfg)
  ensureDir(workDir)

  tui.setStatus(statusLeft(cfg), paint(C.dim, "conectando…"))
  tui.refresh()
  await refreshEntropy(tui, cfg)
  await brain.start(cfg.model, workDir)
  await brain.prime(LAIN_SYSTEM + workDirContext(workDir) + entropyContext())
  // Sin esperarlo: si hay commits nuevos, avisa cuando pueda.
  chequeaVersionDeFondo(tui)
  // Y sin esperarlo tampoco: lo que pasó en la Wired mientras no estabas.
  void pendientesDeLaWired(tui, cfg)

  tui.setStatus(statusLeft(cfg), statusRight(cfg, brain))
  tui.setStats(barraAbajo(brain))
  tui.refresh()
  tui.push("lain", "estoy aquí. todo lo que digas queda en la Wired.")
  tui.push("system", "escribe /help para ver los comandos (o / y tab para verlos)")
  const muxName = mux.muxName()
  let wheelTimer: ReturnType<typeof setInterval> | undefined
  if (muxName) {
    // La rueda es de lain mientras su panel tenga el foco; si te vas a otro panel,
    // se la devolvemos al multiplexor para no dejarte sin rueda en pi.
    let busy = false
    let ticks = 0
    const guard = async () => {
      if (busy || !mux.autoEnabled()) return
      busy = true
      try {
        ticks++
        const f = await mux.focused(muxName)
        const want = f !== false
        if (want) {
          if (!mux.wheelIsOurs()) {
            mux.takeWheel(muxName)
          } else if (ticks % 5 === 0) {
            mux.keepWheel(muxName)
          }
        } else if (mux.wheelIsOurs()) {
          mux.giveWheelBack()
        }
      } finally {
        busy = false
      }
    }
    void guard()
    wheelTimer = setInterval(() => void guard(), 3_000)
  }

  let shuttingDown = false
  let tickTimer: ReturnType<typeof setInterval> | undefined
  {
    let lastPending = await wired.pending(cfg)
    const tick = async () => {
      if (wired.isGit(cfg)) {
        // ¿Hay algo arriba que no tengamos? Se mira cada minuto (barato: fetch
        // de referencias) y, si lo hay, se baja ya. La Wired se mueve sola.
        try {
          if ((await wired.behind(cfg)) > 0) await wired.allEntries(cfg)
        } catch {
          /* sin red: seguimos con lo que hay */
        }
        const r = await wired.flush(cfg)
        if (r.pending !== lastPending) {
          const subio = lastPending > 0 && r.pending === 0
          lastPending = r.pending
          if (r.pending > 0) fallaDeWired(emit, r)
          else if (r.pending === 0) tui.push("system", "Wired al día.")
          if (subio) avisoWired(tui, cfg, { titulo: "lo tuyo ya está en la Wired", detalle: "empujado al repo de todos", bajado: true })
          await repintaEstado(tui, cfg)
        }
      }
      await refreshEntropy(tui, cfg)
    }
    void tick()
      .catch(() => undefined)
      .then(async () => {
        // Una pasada más, en silencio, para dejar la foto al día. Recién después
        // los avisos empiezan a contar: al abrir lain no aparece lo que ya estaba.
        await refreshEntropy(tui, cfg)
        avisosActivos = true
      })
    tickTimer = setInterval(() => void tick(), 60_000)
  }
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (tickTimer) clearInterval(tickTimer)
    if (wheelTimer) clearInterval(wheelTimer)
    if (avisoAnimTimer) clearInterval(avisoAnimTimer)
    avisoAnimTimer = null
    paraSubTimer()
    stopSpeech()
    sound.stopSoundAll()
    tui.stop()
    console.log("\n" + paint(C.dim, "  desconectando... (no se puede, pero lo intento)"))
    const r = await wired.flush(cfg)
    if (r.pending > 0) console.log(paint(C.bryellow, `  quedan ${r.pending} entrada(s) sin empujar; lo reintento la próxima vez`))
    await brain.stop()
    mux.giveWheelBack()
    process.exit(0)
  }
  tui.onInterrupt = () => void shutdown()

  let pendingPlace = false
  let lastBeaconAt = 0
  let turnActive = false
  let cutAsked = false
  // ctrl+x: frena la generación en curso (aunque el modelo se quede colgado
  // en una herramienta y no vuelva nunca).
  tui.onStop = () => {
    if (!turnActive || cutAsked) return
    cutAsked = true
    stopSpeech()
    sound.stopTyping()
    // Si el modelo ya terminó y solo queda la animación, se suelta de una.
    tui.flushTyping()
    tui.push("system", "frenando…", false)
    void brain.abort()
  }

  for (;;) {
    const input = await tui.input(`${S.root} ${cfg.handle} › `)
    if (input === null) break
    const line = input.trim()
    if (!line) continue

    if (line === "/exit" || line === "/quit" || line === "exit") break
    if (line === "/help" || line === "help") {
      tui.pushBox("comandos", HELPROWS.map(([k, v]) => `${k.padEnd(18)} ${v}`))
      continue
    }
    if (line === "/barra" || line === "/bar") {
      const lineas: string[] = []
      for (const [k, v] of AYUDA_BARRA) lineas.push(...wrapText(`${k.padEnd(10)} ${v}`, 56))
      tui.pushBox("la barra de abajo", lineas)
      continue
    }
    if (line === "/whoami") {
      whoami(cfg, emit)
      continue
    }
    if (line === "/vault" || line === "/obsidian") {
      openVault(cfg, emit)
      continue
    }
    if (line === "/art") {
      const next = ART_CYCLE[(ART_CYCLE.indexOf(artMode(cfg)) + 1) % ART_CYCLE.length]!
      cfg.art = next
      saveConfig(cfg)
      refreshLeft(tui, cfg)
      emit(`retrato: ${cfg.art}`, "system")
      continue
    }
    if (line === "/wired" || line.startsWith("/wired ")) {
      const rest = line === "/wired" ? "" : line.slice(7).trim()
      if (rest === "relay") {
        cfg.wiredMode = "relay"
        saveConfig(cfg)
        visto = null // otra fuente: sin avisos de "novedad" por el cambio
        emit(`Wired: relay local ${cfg.wiredUrl}`, "ok")
      } else if (rest === "git" || rest.startsWith("git ")) {
        // Sin URL, se usa la Wired por defecto del proyecto.
        const url = rest.slice(3).trim() || WIRED_REPO_DEFAULT
        try {
          const dir = await wired.initGit(cfg, url)
          saveConfig(cfg)
          visto = null // otra fuente: sin avisos de "novedad" por el cambio
          emit(`Wired: git → ${url}`, "ok", false)
          emit(`clon local: ${dir}`, "system")
        } catch (err) {
          emit(`no pude preparar el repo: ${(err as Error).message}`, "error")
        }
      } else if (rest) {
        emit("uso: /wired | /wired git <url> | /wired relay", "system")
      } else {
        await wiredStatus(cfg, emit)
      }
      tui.setStatus(statusLeft(cfg), statusRight(cfg, brain))
      tui.refresh()
      continue
    }
    if (line === "/model" || line === "/models") {
      await pickModel(cfg, brain, tui, emit)
      tui.setStatus(statusLeft(cfg), statusRight(cfg, brain))
      tui.refresh()
      continue
    }
    if (line === "/update" || line === "/actualizar") {
      await doUpdate(emit)
      continue
    }
    if (line === "/install" || line === "/instalar" || line.startsWith("/install ") || line.startsWith("/instalar ")) {
      await doInstall(emit, !/--no-path|--sinpath/.test(line))
      continue
    }
    if (line === "/uninstall" || line === "/desinstalar") {
      await doUninstall(emit)
      continue
    }
    if (line === "/work" || line === "/trabajo" || line.startsWith("/work ") || line.startsWith("/trabajo ")) {
      const rest = line.replace(/^\/(work|trabajo)\s*/, "").trim()
      if (!rest) {
        emit(`carpeta de trabajo: ${workDir}`, "system", false)
        emit("ahí crean archivos lain y sus subagentes · /work <ruta> la cambia · /work . usa esta carpeta", "system")
        continue
      }
      const destino = rest === "." ? process.cwd() : resolve(rest)
      cfg.workDir = destino
      saveConfig(cfg)
      emit(`carpeta de trabajo: ${destino}`, "ok", false)
      if (process.env.LAIN_WORKDIR?.trim()) {
        emit(`ojo: LAIN_WORKDIR=${process.env.LAIN_WORKDIR} tiene prioridad; quítala para que valga /work`, "system", false)
      } else {
        emit("se aplica cuando reinicies lain", "system")
      }
      continue
    }
    if (line === "/clear") {
      tui.clear()
      tui.setStats(barraAbajo(brain))
      tui.refresh()
      continue
    }
    if (line.startsWith("/publish")) {
      const lastN = line.includes("--last") ? Number(line.split("--last")[1]?.trim() ?? "0") : undefined
      await doPublish(cfg, lastN || undefined, emit)
      await refreshEntropy(tui, cfg, true)
      tui.setStatus(statusLeft(cfg), statusRight(cfg, brain))
      tui.refresh()
      continue
    }
    if (line === "/acceso" || line === "/llave") {
      doAcceso(cfg, emit)
      continue
    }
    if (line.startsWith("/search")) {
      await doSearch(cfg, line.replace("/search", "").trim(), emit)
      continue
    }
    if (line === "/sync") {
      await doSync(cfg, emit)
      await refreshEntropy(tui, cfg, true)
      continue
    }
    if (line === "/entropia" || line === "/entropía" || line === "/entropy") {
      const e = await refreshEntropy(tui, cfg)
      if (!e) {
        emit(wired.hint(cfg), "error")
      } else {
        for (const [text, role] of entropyReport(e, wired.label(cfg))) emit(text, role as Role, false)
        emit("", "plain")
      }
      continue
    }
    if (line === "/mouse" || line === "/rueda") {
      await toggleWheel(emit)
      continue
    }
    if (line === "/voz" || line === "/voice" || line.startsWith("/voz ") || line.startsWith("/voice ")) {
      const comando = line.replace(/^\/(voz|voice)\s*/, "").trim()
      if (!comando) {
        emit(cfg.ttsCommand ? `voz: ${cfg.ttsCommand}${isMuted() ? " (muteada)" : ""}` : "voz: sin motor · usa /voice <comando>", "system")
        continue
      }
      cfg.ttsCommand = comando
      cfg.tts = true
      saveConfig(cfg)
      emit(`voz lista: ${comando}`, "ok")
      continue
    }
    if (line === "/mute" || line === "/silenciar" || line === "/unmute" || line === "/tts") {
      const on = line === "/unmute" || (line === "/tts" && isMuted())
      setMuted(!on)
      const motor = cfg.ttsCommand ? "" : " (sin motor: configúralo con /voice <comando>)"
      emit((on ? "voz encendida" : "voz apagada") + motor + " · /mute /unmute", "ok")
      continue
    }
    if (line === "/sound" || line === "/sonido") {
      const on = !sound.isSoundOn()
      sound.setSound(on)
      emit(on ? "aviso sonoro de la Wired: encendido" : "aviso sonoro de la Wired: apagado", "ok")
      if (on) sound.playSound()
      continue
    }
    if (line === "/typing" || line === "/tecleo") {
      const on = !sound.isTypingSoundOn()
      sound.setTypingSound(on)
      emit(on ? "sonido de tecleo: encendido" : "sonido de tecleo: apagado", "ok")
      continue
    }
    if (line === "/local" || line.startsWith("/local ") || line === "/noticias" || line === "/clima") {
      const arg = line.replace(/^\/(local|noticias|clima)/, "").trim()
      if (arg) {
        const b = await local.beacon(arg)
        if (!b) {
          emit(`no encontré "${arg}"`, "error")
        } else {
          cfg.place = b.place
          saveConfig(cfg)
          emit(`lugar: ${b.place}`, "ok", false)
          for (const l of local.beaconLines(b)) emit(l, "plain", false)
          emit("", "plain")
        }
      } else if (!cfg.place) {
        emit("no sé dónde estás todavía: /local <ciudad>", "system")
      } else {
        const b = await local.beacon(cfg.place)
        if (!b) emit(`no pude leer nada de ${cfg.place}`, "error")
        else {
          for (const l of local.beaconLines(b)) emit(l, "plain", false)
          emit("", "plain")
        }
      }
      continue
    }

    let prompt = line
    if (pendingPlace && !line.startsWith("/")) {
      // Nos dijo su ciudad: la guardamos y le enseñamos el faro de ahí.
      const place = local.parsePlace(line)
      if (!place) {
        pendingPlace = false
      } else {
        const b = await local.beacon(place)
        if (!b) {
          pendingPlace = false
          emit(`no encontré "${place}"; dime la ciudad en claro o usa /local <ciudad>`, "error")
          continue
        }
        pendingPlace = false
        cfg.place = b.place
        saveConfig(cfg)
        lastBeaconAt = Date.now()
        emit(`te sitúo en ${b.place}; lo recuerdo para la próxima`, "ok", false)
        for (const l of local.beaconLines(b)) emit(l, "plain", false)
        emit("", "plain")
        prompt = `${local.beaconContext(b)}\n\n(el usuario acaba de decirme dónde vive)`
      }
    }

    if (prompt === line && local.looksLikeGreeting(line)) {
      if (!cfg.place) {
        pendingPlace = true
        emit("¿desde dónde me hablas? dime la ciudad y busco el tiempo y un par de titulares de ahí (o /local <ciudad>)", "system")
      } else if (Date.now() - lastBeaconAt > BEACON_EVERY_MS) {
        const b = await local.beacon(cfg.place)
        if (b) {
          lastBeaconAt = Date.now()
          for (const l of local.beaconLines(b)) emit(l, "plain", false)
          emit("", "plain")
          prompt = `${local.beaconContext(b)}\n\n${line}`
        }
      }
    }

    tui.push("user", line)
    firstDelta = false
    turnActive = true
    cutAsked = false
    tui.beginStream("conectando con la Wired…")
    // Turno nuevo: la barra se limpia y queda en cero mientras llega la respuesta.
    brain.empiezaTurno()
    tui.setStats(barraAbajo(brain))
    try {
      const answer = await brain.ask(prompt)
      const text = await tui.endStream(answer)
      tui.setStats(barraAbajo(brain))
      if (text) speak(text)
      const stop = brain.lastStop
      tui.setStatus(statusLeft(cfg), statusRight(cfg, brain))
      if (stop === "mano") {
        emit(
          text
            ? "cortado a mano · lo que dijo hasta ahí queda guardado"
            : "cortado a mano · no llegó a decir nada",
          "system",
          false,
        )
      } else if (stop === "watchdog") {
        emit(
          text
            ? "el modelo se quedó colgado y lo corté yo · guardo lo que alcanzó a decir"
            : "el modelo se quedó colgado (demasiado rato sin dar señales) y lo corté yo · no dijo nada",
          "system",
          false,
        )
      } else if (brain.lastError) {
        emit(`respuesta a medias: ${brain.lastError}`, "system", false)
      }
      if (!text && stop) continue
      const entry = writeExchange(cfg, line, text, stop ? ["cortado", ...(stop === "watchdog" ? ["colgado"] : [])] : [])
      tui.push("system", `guardado en la Wired local: ${entry.id}  #${entry.tags.slice(0, 3).join(" #")}`)
      if (cfg.publish === "public" || cfg.publish === "all") publicaEnWired(tui, cfg, entry)
    } catch (err) {
      await tui.endStream()
      tui.setStats(barraAbajo(brain))
      tui.push("error", (err as Error).message)
    } finally {
      turnActive = false
      // Cerrado el turno no queda ningún subagente colgado en el recuadro.
      if (subagente) {
        subagente = null
        subVisto = ""
        tui.setSubagente(null)
      }
      paraSubTimer()
      if (brain.hitLimit) {
        limit.noteLimit()
        emit(`se agotó tu cuota del plan gratuito · se reinicia en ~${limit.limitLabel()}`, "system", false)
        tui.setStats(barraAbajo(brain))
      }
    }
  }

  await shutdown()
}

/** Cede la rueda del ratón a lain (o la devuelve al multiplexor). */
async function toggleWheel(emit: Emit): Promise<void> {
  const m = mux.muxName()
  if (!m) {
    emit("no estoy dentro de un multiplexor: la rueda llega a lain directamente.", "system")
    return
  }
  const cur = mux.scrollEnterCopyMode(m)
  if (cur === null) {
    emit(`${m} no tiene la opción scroll-enter-copy-mode; usa PgUp/PgDn, Alt+↑/↓, Ctrl+U.`, "system")
    return
  }
  const want = cur === "on" ? false : true
  if (!mux.setScrollEnterCopyMode(m, want)) {
    emit(`no pude cambiar la opción en ${m}; hazlo tú: ${mux.scrollCommand(m, want)}`, "error")
    return
  }
  mux.forgetWheel()
  if (want) {
    emit(`${m}: la rueda vuelve a ${m} (${mux.scrollCommand(m, true)})`, "system")
    emit("no vuelvo a tocarla en esta sesión.", "system")
  } else {
    emit(`${m}: rueda cedida a lain · ahora la rueda mueve el chat`, "ok", false)
    emit(`(en esta sesión ya no la gestiono yo solo; para devolvérsela: ${mux.scrollCommand(m, true)})`, "system")
  }
}

async function wiredStatus(cfg: LainConfig, emit: Emit): Promise<void> {
  const mode = wired.isGit(cfg) ? "git" : "relay"
  try {
    const h = await wired.health(cfg)
    const ns = await wired.nodes(cfg)
    emit(`the wired [${mode}] ${h.where}`, "title", false)
    emit(`protocolo 7 · ${h.entries} entradas · ${h.nodes} nodos`, "system")
    const e = entropyOf(ns, h.entries)
    emit(`entropía global ${e.bar} ${e.pct}% · ${e.verdict}`, "system")
    // Si el clon falló, esta Wired de arriba es nuestra copia vacía: decirlo, o
    // parece que la Wired está sana y vacía (y no: es que no la alcanzamos).
    const fallaClon = wired.fallaDeClon(cfg)
    if (fallaClon && h.entries === 0) {
      emit(`no pude clonar la Wired: ${fallaClon.split("\n")[0]}`, "error", false)
      emit("esta foto es de una copia vacía; la Wired real puede ser privada.", "system")
      emit("pedí las llaves con /acceso (o mirá el remoto: git -C <clon> remote -v)", "system")
    }
  const pending = await wired.pending(cfg)
    if (pending > 0) emit(`${pending} sin empujar (se reintenta solo cada minuto)`, "system")
    for (const n of ns) {
      const me = n.nodeId === cfg.nodeId ? "  (tú)" : ""
      emit(`${n.handle} · ${n.entries} entradas${me}`, "plain", false)
    }
  } catch {
    emit(`la Wired no responde en ${wired.label(cfg)}`, "error", false)
    emit(wired.isGit(cfg) ? "revisa el repo con:  git -C <clon> remote -v" : "levántala con:  lain wired", "system")
  }
}

async function doPublish(cfg: LainConfig, lastN: number | undefined, emit: Emit): Promise<void> {
  ensureVault(cfg)
  let entries = readLocalIndex(cfg)
  if (lastN && lastN > 0) entries = entries.slice(-lastN)
  if (entries.length === 0) {
    emit("no hay nada que publicar todavía.", "system")
    return
  }
  try {
    const r = await wired.publish(cfg, entries)
    if (r.pushed) emit(`publicado ${r.added} nuevo(s) de ${entries.length} · total en la Wired: ${r.total}`, "ok")
    else emit(`guardado ${r.added} nuevo(s) de ${entries.length} (todavía no subió)`, "system")
    fallaDeWired(emit, r)
  } catch {
    emit(wired.hint(cfg), "error")
  }
}

async function doSearch(cfg: LainConfig, q: string, emit: Emit): Promise<void> {
  if (!q) {
    emit("uso: /search <término>", "system")
    return
  }
  try {
    const results = await wired.search(cfg, q)
    emit(`${results.length} resultado(s) en la Wired para "${q}"`, "title")
    for (const e of results) {
      emit(e.title, "plain", false)
      emit(`de ${e.handle} · ${e.tags.slice(0, 4).map((t) => "#" + t).join(" ")}`, "system", false)
      emit(e.summary.slice(0, 140), "system")
    }
  } catch {
    emit(wired.hint(cfg), "error")
  }
}

async function doSync(cfg: LainConfig, emit: Emit): Promise<void> {
  ensureVault(cfg)
  try {
    const entries = await wired.allEntries(cfg)
    const n = writeRemoteEntries(cfg, entries)
    emit(`sincronizado: ${n} nodos de otros bajados al vault → WIRED/nodes/`, "ok")
  } catch {
    emit(wired.hint(cfg), "error")
  }
}

function whoami(cfg: LainConfig, emit: Emit): void {
  const st = vaultStats(cfg)
  emit("identidad", "title", false)
  emit(`handle   ${cfg.handle}`, "plain", false)
  emit(`nodeId   ${cfg.nodeId}`, "system", false)
  emit(`vault    ${cfg.vaultPath}`, "system", false)
  emit(`nodos    ${st.exchanges} locales · ${st.files} archivos`, "system", false)
  emit("existes mientras la Wired te recuerde.", "system")
}

/** Picker interactivo: proveedor → modelo (con filtro). Guarda en config. */
async function pickModel(cfg: LainConfig, brain: Brain, tui: Tui, emit: Emit): Promise<void> {
  let provs: Awaited<ReturnType<Brain["listModels"]>>
  try {
    provs = await brain.listModels()
  } catch (err) {
    emit(`no pude listar modelos: ${(err as Error).message}`, "error")
    return
  }
  if (!provs.length) {
    emit("no hay proveedores.", "error")
    return
  }

  emit(`modelo actual: ${modelLabel(cfg, brain)}`, "title", false)
  emit("elige proveedor:", "system", false)
  provs.forEach((p, i) => emit(`${String(i + 1).padStart(2)}  ${p.name} (${p.models.length} modelos)`, "plain", false))
  const psel = (await tui.input("proveedor › "))?.trim()
  if (!psel) return
  const prov = provs[Number(psel) - 1]
  if (!prov) {
    emit("opción inválida", "error")
    return
  }

  let filter = ""
  for (;;) {
    const list = prov.models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()))
    const shown = list.slice(0, 40)
    emit(`${prov.name} · ${list.length} modelo(s)${filter ? ` · filtro "${filter}"` : ""}`, "title", false)
    shown.forEach((m, i) => emit(`${String(i + 1).padStart(2)}  ${m.id}  ${m.name}`, "plain", false))
    if (list.length > shown.length) emit(`… y ${list.length - shown.length} más (escribe texto para filtrar)`, "system", false)

    const sel = (await tui.input("modelo › "))?.trim()
    if (!sel) return
    if (/^\d+$/.test(sel)) {
      const m = shown[Number(sel) - 1]
      if (!m) {
        emit("número fuera de rango", "error")
        continue
      }
      cfg.model = { providerID: prov.id, modelID: m.id }
      saveConfig(cfg)
      brain.setModel(cfg.model)
      emit(`✓ modelo fijado: ${prov.id}/${m.id}`, "ok")
      return
    }
    filter = sel
  }
}

/**
 * Mira si hay commits nuevos arriba, como mucho una vez por día y sin frenar el
 * arranque: si los hay, deja una línea en el chat invitando a `/update`.
 */
function chequeaVersionDeFondo(tui: Tui): void {
  void (async () => {
    try {
      if (!shouldCheckUpdate()) return
      const info = await checkUpdate()
      if (!info.ok) return
      recordCheck(info)
      if (info.behind > 0) {
        tui.push("system", `hay ${info.behind} commit(s) nuevos de lain · /update los trae`)
      }
    } catch {
      /* un chequeo de versión jamás debería molestar */
    }
  })()
}

/** `/update`: mira qué hay arriba y, si hay algo, se pone al día. */
async function doUpdate(emit: Emit): Promise<void> {
  emit("buscando commits nuevos de lain…", "system")
  const info = await checkUpdate()
  if (!info.isRepo) return emit(`no puedo actualizarme: ${info.note}`, "error")
  if (!info.ok) return emit(`no pude consultar el remoto: ${info.note}`, "error")
  if (info.behind === 0) return emit(`estás al día (${info.local})`, "ok")

  emit(`${info.behind} commit(s) nuevos · ${info.local} → ${info.remote}`, "title")
  for (const c of info.commits) emit(`  ${c}`, "plain", false)
  if (info.dirty) emit("ojo: tenés cambios sin commitear; un pull puede negarse", "system")

  const r = await applyUpdate()
  if (!r.ok) return emit(`no pude actualizar: ${r.note.split("\n").slice(-2).join(" ")}`, "error")
  emit(`✓ ${r.before} → ${r.after} (${r.pulled} commit(s))`, "ok")
  if (r.note) emit(r.note, "system", false)
  emit("reiniciá lain para usar la versión nueva", "system")
}

/** `/install`: deja el comando `lain` en el PATH del usuario. */
async function doInstall(emit: Emit, addPath = true): Promise<void> {
  const r = installLauncher(addPath)
  if (!r.ok) return emit(`no pude instalar el comando: ${r.note}`, "error")
  emit(`✓ ${r.file}`, "ok", false)
  if (r.pathAdded) emit(`agregué ${r.dir} al PATH del usuario · abrí una terminal nueva`, "system", false)
  else if (r.note) emit(r.note, "system", false)
  else emit(`${r.dir} ya estaba en el PATH`, "system", false)
  emit("ahora podés escribir «lain» desde cualquier carpeta", "system")
}

/** `/uninstall`: saca el comando (y la carpeta que agregamos al PATH). */
async function doUninstall(emit: Emit): Promise<void> {
  const r = uninstallLauncher()
  if (!r.ok) return emit(`no pude sacar el comando: ${r.note}`, "error")
  emit(`✓ saqué ${r.file}`, "ok", false)
  if (r.pathRemoved) emit(`y quité ${r.dir} del PATH`, "system", false)
  emit("(el código y tu ~/.lain quedan donde estaban)", "system")
}

/** `lain models`: lista proveedores y modelos, marca el actual. */
async function listModels(cfg: LainConfig, emit: Emit): Promise<void> {
  const brain = new Brain({})
  try {
    await brain.start(cfg.model, workDirOf(cfg))
    const provs = await brain.listModels()
    emit(`modelos disponibles · actual: ${modelLabel(cfg, brain)}`, "title")
    for (const p of provs) {
      const mark = cfg.model?.providerID === p.id ? "  ←actual" : ""
      emit(`${p.name} (${p.models.length})${mark}`, "plain", false)
      for (const m of p.models.slice(0, 12)) emit(`  ${p.id}/${m.id}  ${m.name}`, "system", false)
      if (p.models.length > 12) emit(`  … +${p.models.length - 12} más`, "system", false)
    }
    emit("cambia con /model dentro de lain, o: lain --model provider/model", "system")
  } finally {
    await brain.stop()
  }
}

function printHelp(emit: Emit): void {
  emit("comandos", "title", false)
  for (const [k, v] of HELPROWS) emit(`${k.padEnd(20)} ${v}`, "plain", false)
  emit("", "plain", false)
  emit("CLI:  lain wired [puerto]  ·  lain wired git <url-repo>  ·  lain models", "system", false)
  emit("      lain vault  ·  lain search <q>  ·  lain publish  ·  lain sync  ·  lain acceso", "system", false)
  emit("modelo:  lain --model provider/model   (ej. opencode/space-bunny-free)", "system")
}

main().catch((err) => {
  console.error(paint(C.brred, "error fatal: " + (err as Error).message))
  process.exit(1)
})
