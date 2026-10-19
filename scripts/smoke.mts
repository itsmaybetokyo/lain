// Prueba de humo: no habla con el modelo ni toca tu ~/.lain real.
// Se aísla en una carpeta temporal (LAIN_HOME) y levanta el relay en un puerto
// libre, así que se puede correr en cualquier máquina sin ensuciar nada.
import { execFileSync } from "node:child_process"
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

  // Lo último de la Wired al abrir: siempre las más nuevas, ya vistas o no.
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
  const dos = visto.ultimasDe(historial, 2)
  check(dos.length === 2, "al abrir entran solo las que caben en el panel")
  check(dos[0]!.title === "la del medio" && dos[1]!.title === "la nueva", "y son las más nuevas, de la vieja a la nueva")
  check(visto.ultimasDe(historial, 0).length === 0, "si no hay lugar, no entra ninguna")

  visto.guardaVistos(historial.map((e) => e.id))
  check(visto.cargaVistos().size === 3, "guardaVistos deja el archivo")
  check(visto.ultimasDe(historial, 3).length === 3, "aunque ya estén vistas, se siguen mostrando al abrir")

  const conUnaMas = [...historial, entrada("d", "2026-06-01T10:00:00Z", "recién publicada")]
  check(!visto.cargaVistos().has("d"), "una nota que llegó después todavía no está marcada")
  check(visto.ultimasDe(conUnaMas, 1)[0]!.title === "recién publicada", "y es la que aparece arriba")

  visto.anotaVisto("d")
  check(visto.cargaVistos().has("d") && visto.cargaVistos().size === 4, "anotaVisto suma sin perder lo anterior")

  writeFileSync(join(home, "wired-visto.json"), "{roto")
  check(visto.cargaVistos().size === 0, "si el archivo está roto, arranca vacío en vez de romper")

  // Permisos de opencode: si pregunta y nadie contesta, el turno se cuelga.
  const { Brain, respondePermiso, explainError } = await import("../src/brain.js")
  check(respondePermiso("external_directory") === "once", "mirar el vault y la Wired fuera de la carpeta de trabajo se concede de a uno")
  check(respondePermiso("doom_loop") === "reject", "un agente que se repite en bucle se rechaza")
  check(respondePermiso("otra_cosa") === "once", "lo que no conocemos se contesta de a uno")

  // El pedido llega con la sesión del subagente: hay que contestarlo ahí.
  const pedidos: any[] = []
  const contes: any[] = []
  const cerebro: any = new Brain({ onPermiso: (p) => contes.push(p) })
  cerebro.client = {
    postSessionIdPermissionsPermissionId: async (args: any) => {
      pedidos.push(args)
    },
  }
  await cerebro.contestaPermiso({ id: "per_1", sessionID: "ses_del_subagente", type: "external_directory", pattern: "C:\\x\\.lain\\*" })
  check(pedidos.length === 1 && pedidos[0].path.id === "ses_del_subagente", "el permiso se contesta en la sesión que lo pidió, no en la principal")
  check(pedidos[0]?.body?.response === "once" && contes.length === 1, "y se concede de a uno, avisando cuál")
  await cerebro.contestaPermiso({ id: "per_1", sessionID: "ses_del_subagente", type: "external_directory" })
  check(pedidos.length === 1, "el mismo pedido no se contesta dos veces")

  // La barra de abajo: cada tramo en su columna y la barra llegando al borde.
  const { barraDeAbajo, AYUDA_BARRA } = await import("../src/bar.js")
  const { stripAnsi: sinAnsi, truncateVisible } = await import("../src/theme.js")
  const reposo = barraDeAbajo({ wired: { badge: "on", entries: 3, pend: 0 }, entropy: null, cols: 160 })
  const lleno = barraDeAbajo({
    wired: { badge: "on", entries: 12000, pend: 9 },
    brain: {
      metrics: () => ({
        tokIn: 12000,
        tokOut: 3456,
        tokReason: 1200,
        cacheRead: 0,
        costo: 0,
        ms: 4200,
        tps: 82.3,
        chars: 900,
        live: true,
      }),
    } as any,
    entropy: { value: 0.61, pct: 61, bar: "▓▓▓░░" } as any,
    limite: "3h 12m",
    cols: 160,
  })
  check(sinAnsi(reposo).length === 159, "la barra ocupa todo el ancho disponible")
  check(sinAnsi(lleno).length === 159, "y sigue llegando al borde con todos los números")
  check(
    sinAnsi(barraDeAbajo({ wired: { badge: "on", entries: 3, pend: 0 }, entropy: null, cols: 171 })).length === 170,
    "también en el ancho real del panel",
  )
  check(
    sinAnsi(reposo).indexOf("tokens") === sinAnsi(lleno).indexOf("tokens"),
    "tokens no se corre cuando cambia la Wired",
  )
  const otro = barraDeAbajo({
    wired: { badge: "on", entries: 8, pend: 0 },
    brain: {
      metrics: () => ({
        tokIn: 900,
        tokOut: 12,
        tokReason: 0,
        cacheRead: 0,
        costo: 0,
        ms: 1100,
        tps: 82.3,
        chars: 40,
        live: false,
      }),
    } as any,
    entropy: { value: 0.1, pct: 10, bar: "▓░░░░" } as any,
    limite: "9h 58m",
    cols: 160,
  })
  check(
    sinAnsi(lleno).indexOf("tok/s") === sinAnsi(otro).indexOf("tok/s"),
    "tok/s no se corre cuando cambian los números",
  )
  check(sinAnsi(lleno).endsWith("61%"), "la entropía queda pegada al borde derecho")
  check(sinAnsi(reposo).endsWith("entropía sin señal"), "y sin señal también")
  const angosto = barraDeAbajo({
    wired: { badge: "on", entries: 12000, pend: 9 },
    brain: {
      metrics: () => ({
        tokIn: 12000,
        tokOut: 3456,
        tokReason: 1200,
        cacheRead: 0,
        costo: 0,
        ms: 4200,
        tps: 82.3,
        chars: 900,
        live: true,
      }),
    } as any,
    entropy: { value: 0.5, pct: 50, bar: "▓▓░░░" } as any,
    limite: "3h 12m",
    cols: 120,
  })
  check(sinAnsi(angosto).length === 119, "en una terminal angosta la barra entra igual")
  check(sinAnsi(angosto).endsWith("50%"), "y el porcentaje de entropía se ve entero")

  // El recorte se comía el último carácter de una línea que medía justo el ancho.
  check(truncateVisible("abcdef", 6) === "abcdef", "una línea que entra justo no se recorta")
  check(sinAnsi(truncateVisible("abcdefg", 6)).endsWith("…"), "una que no entra sí se corta con …")
  check(
    sinAnsi(truncateVisible(" " + lleno, 160)).endsWith("61%"),
    "y al dibujar la barra no se pierde el %",
  )
  check(AYUDA_BARRA.every(([, v]) => v.length > 8), "cada tramo trae su explicación para /barra")

  // El efecto letra por letra no puede volver a soltar todo junto.
  const { letrasPorTick } = await import("../src/tui.js")
  check(
    letrasPorTick(5) === 1 && letrasPorTick(300) === 2 && letrasPorTick(3000) === 3,
    "el texto sale letra por letra (a lo sumo 3 por tick)",
  )

  // El sonido de tecleo sigue a lo que se escribe, no a lo que llega del modelo:
  // si el modelo entrega todo junto y la escritura sigue, no se puede apagar.
  {
    const { Tui } = await import("../src/tui.js")
    const out = process.stdout as any
    const inn = process.stdin as any
    const antes = {
      outTty: out.isTTY,
      cols: out.columns,
      rows: out.rows,
      inTty: inn.isTTY,
      raw: inn.setRawMode,
      write: out.write,
    }
    out.isTTY = true
    out.columns = 100
    out.rows = 30
    inn.isTTY = true
    inn.setRawMode = () => {}
    out.write = () => true // el TUI pinta en la pantalla alternativa: acá no interesa

    const tui = new Tui({ userName: "smoke" })
    const ev: boolean[] = []
    tui.onTyping = (on) => ev.push(on)
    tui.start()
    tui.beginStream("escribiendo…")
    tui.streamChunk("x".repeat(40))
    const apenas = ev.length
    await new Promise((r) => setTimeout(r, 260))
    const escribiendo = ev[0] === true && !ev.includes(false)
    tui.flushTyping()
    tui.stop()

    out.write = antes.write
    out.isTTY = antes.outTty
    out.columns = antes.cols
    out.rows = antes.rows
    inn.isTTY = antes.inTty
    inn.setRawMode = antes.raw

    check(apenas === 0, "el sonido no arranca solo porque llegue texto del modelo")
    check(escribiendo, "arranca cuando lain empieza a escribir y no se corta mientras escribe")
  }

  const conCausa = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } })
  const colgado = explainError(conCausa("UND_ERR_HEADERS_TIMEOUT"))
  check(/servidor de opencode/.test(colgado) && !/no hay red/.test(colgado), "un turno que se cuelga no se cuenta como falta de red")
  check(/servidor local/.test(explainError(conCausa("ECONNREFUSED"))), "si el servidor local se cerró, lo dice")
  const caida = explainError(conCausa("ENOTFOUND"))
  check(/no hay red/.test(caida) && /ENOTFOUND/.test(caida), "una caída de red de verdad se cuenta como tal, con el código")

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

  // Pedir las llaves de la Wired: el pedido se arma solo y va a un repo que el
  // otro alcanza seguro (el de lain, público: de ahí se bajó el programa). El de
  // la Wired puede ser privado, y un repo privado no deja abrir issues a quien no lo ve.
  const acceso = await import("../src/wired/acceso.js")
  const gitw = await import("../src/wired/git.js")
  const { ACCESS_REPO_DEFAULT } = await import("../src/config.js")

  check(acceso.slugDeRepo("https://github.com/itsmaybetokyo/wired") === "itsmaybetokyo/wired", "saca dueño/repo de una URL de git")
  check(acceso.slugDeRepo("git@github.com:itsmaybetokyo/wired.git") === "itsmaybetokyo/wired", "y también de una URL ssh")
  check(acceso.slugDeRepo("https://gitlab.com/x/y") === null, "fuera de GitHub no hay dónde pedir (null)")

  cfgA.wiredRepo = "https://github.com/itsmaybetokyo/wired"
  const pedido = acceso.urlDelPedido(cfgA, "no tengo permiso")!
  check(pedido.startsWith(`${ACCESS_REPO_DEFAULT}/issues/new?`), "el pedido va al repo público de lain, no al de la Wired")
  check(pedido.includes(encodeURIComponent(cfgA.nodeId)), "el pedido lleva el nodeId, para que te encuentren")
  check(decodeURIComponent(pedido).includes("alice"), "y el handle, para que sepan quién pide")
  check(!pedido.includes("+"), "los espacios van como %20 (con + GitHub los muestra crudos)")

  // El 403 de GitHub dice «Permission to <repo>.git denied to <alguien>»: antes
  // caía en «sin conexión», que te mandaba a revisar el router.
  const sinPermiso =
    "remote: Permission to itsmaybetokyo/wired.git denied to somebody.\nfatal: unable to access 'https://github.com/itsmaybetokyo/wired/': The requested URL returned error: 403"
  const sinCredenciales = "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
  const sinRed = "fatal: unable to access 'https://github.com/itsmaybetokyo/wired/': Failed to connect to github.com port 443"

  check(gitw.fallaDePush(sinPermiso, true) === "sin-permiso", "un 403 de GitHub es falta de permiso, no de red")
  check(gitw.fallaDePush(sinCredenciales, false) === "sin-credenciales", "sin credenciales de git se dice tal cual")
  check(gitw.fallaDePush(sinRed, true) === "sin-conexion", "un fallo de red sigue siendo sin conexión")
  check(gitw.pideAcceso(gitw.fallaDePush(sinPermiso, true)), "falta de permiso: ofrece pedir las llaves")
  check(gitw.pideAcceso(gitw.fallaDePush(sinCredenciales, false)), "sin credenciales: también")
  check(!gitw.pideAcceso(gitw.fallaDePush(sinRed, true)), "un problema de red no se arregla pidiendo acceso")
  check(gitw.pushNote("sin-permiso").includes("permiso"), "el mensaje dice permiso, no «sin conexión»")
  check(gitw.pushNote("sin-conexion") === "sin conexión", "y el de red sigue diciendo lo mismo")

  const protegida = "! [remote rejected] main -> main (protected branch hook declined)"
  check(gitw.fallaDePush(protegida, true) === "rechazado", "una rama protegida no es «sin conexión»: es el repo rechazando")
  check(!gitw.pideAcceso(gitw.fallaDePush(protegida, true)), "ahí permiso hay: pedir acceso no tiene sentido")

  // Un clon que falla queda registrado: sin eso diríamos «Wired on · 0 notas»
  // sobre una copia vacía, y el otro creería que la Wired está sana y vacía.
  check(gitw.fallaDeClon(cfgA) === null, "sin clon fallido, no inventa una falla")
  const cfgClon = loadConfig()
  cfgClon.wiredDir = join(home, "clon-roto")
  cfgClon.wiredRepo = join(home, "no-existe-jamas")
  gitw.ensureRepo(cfgClon)
  check(!!gitw.fallaDeClon(cfgClon), "un clon fallido se recuerda en vez de disimularse")

  // El rescate: si el clon falló alguna vez (no tenías llave), queda una copia
  // suelta que nunca se vuelve a clonar. Cuando por fin alcanzás la Wired, lain
  // engancha la historia sola, en vez de dejarte para siempre en una paralela.
  if (gitw.gitAvailable()) {
    const gitFn = (args: string[], cwd?: string): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const quien = ["-c", "user.name=otro", "-c", "user.email=otro@wired.local"]
    const wiredReal = join(home, "wired-real.git")
    gitFn(["init", "--bare", "-b", "main", wiredReal])
    const armado = join(home, "armado")
    gitFn(["clone", wiredReal, armado])
    writeFileSync(join(armado, "nota-de-otro.md"), "de otro nodo\n")
    gitFn(["add", "-A"], armado)
    gitFn([...quien, "commit", "-m", "wired: otro +1"], armado)
    gitFn(["push", "origin", "HEAD:main"], armado)

    // Copia suelta: init + remote + una nota propia, tal como queda tras un clon fallido.
    const cfgSuelto = loadConfig()
    cfgSuelto.handle = "suelto"
    cfgSuelto.wiredRepo = wiredReal
    cfgSuelto.wiredDir = join(home, "clon-suelto")
    gitFn(["init", "-b", "main", cfgSuelto.wiredDir])
    gitFn(["remote", "add", "origin", wiredReal], cfgSuelto.wiredDir)
    writeFileSync(join(cfgSuelto.wiredDir, "mia.md"), "lo mio\n")
    gitFn(["add", "-A"], cfgSuelto.wiredDir)
    gitFn([...quien, "commit", "-m", "wired: suelto +1"], cfgSuelto.wiredDir)

    gitw.ensureRepo(cfgSuelto)
    const historia = gitFn(["log", "--oneline", "main"], cfgSuelto.wiredDir)
    check(historia.includes("otro +1") && historia.includes("suelto +1"), "el rescate engancha lo mío con la Wired de verdad")
    check(gitw.fallaDeClon(cfgSuelto) === null, "y una vez adentro, ya no hay nada que reclamar")
    const subida = await gitw.flushGitAsync(cfgSuelto)
    check(subida.pushed && subida.pending === 0, "lo guardado mientras no tenía llave termina arriba igual")
  } else {
    console.log("(sin git: me salteo las pruebas de repo)")
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
