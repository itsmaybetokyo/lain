import { createOpencodeClient } from "@opencode-ai/sdk"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { looksLikeLimit } from "./limit.js"

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 4096
      srv.close(() => resolve(port))
    })
  })
}

export interface BrainEvents {
  onDelta?: (chunk: string) => void
  onTool?: (name: string) => void
  onStatus?: (status: string) => void
  /** Se dispara una vez cuando el modelo empieza a "pensar" (reasoning oculto). */
  onReasoning?: () => void
  /** Subagente en curso (o `null` cuando termina): alimenta el recuadro del composer. */
  onSubtask?: (s: { id: string; descripcion: string; agente: string; desde: number } | null) => void
  /** opencode pidió un permiso y lain lo contestó (si no, el turno se cuelga). */
  onPermiso?: (p: { tipo: string; patron: string; respuesta: RespuestaPermiso }) => void
  /** opencode quiere preguntarle algo al usuario y lain no tiene con qué: se rechaza y se muestra. */
  onPregunta?: (q: Pregunta) => void
}

/** Lo que acepta opencode al contestar un permiso. */
export type RespuestaPermiso = "once" | "always" | "reject"

/** Eventos que muestran trabajo real: un permiso esperando no es progreso. */
const esProgreso = (tipo: unknown): boolean =>
  tipo === "message.part.delta" ||
  tipo === "message.part.updated" ||
  tipo === "message.updated" ||
  tipo === "session.idle"

/**
 * Qué contestamos cuando opencode pide un permiso. Nadie más puede hacerlo, así
 * que la política es explícita: se concede de a uno (nunca "siempre", que
 * quedaría como un permiso permanente que no pediste); el detector de bucles se
 * rechaza, porque quiere decir que el agente se está repitiendo.
 */
export function respondePermiso(tipo: string): RespuestaPermiso {
  if (tipo === "doom_loop") return "reject"
  return "once"
}

/** Un pedido de permiso, ya normalizado. */
export type Permiso = { id: string; sesion: string; tipo: string; patron: string }
/**
 * ¿El evento es un pedido de permiso? opencode 1.19 lo manda como
 * `permission.asked`; antes se llamaba `permission.updated`. Se aceptan los dos
 * porque el nombre cambió sin avisar y escuchar el viejo dejaba el turno colgado.
 */
export function esEventoPermiso(tipo: unknown): boolean {
  return tipo === "permission.asked" || tipo === "permission.updated"
}

/**
 * Normaliza un pedido de permiso venga como evento o tal cual desde
 * `GET /permission`: opencode 1.19 usa `permission`/`patterns` y el viejo
 * `type`/`pattern`.
 */
export function normalizaPermiso(p: any): Permiso | null {
  const id = String(p?.id ?? "")
  if (!id) return null
  const patrones = p?.patterns ?? p?.pattern ?? p?.patron
  return {
    id,
    sesion: String(p?.sessionID ?? p?.sesion ?? ""),
    tipo: String(p?.permission ?? p?.type ?? p?.tipo ?? ""),
    patron: Array.isArray(patrones) ? patrones.join(", ") : String(patrones ?? ""),
  }
}

/** Una pregunta de la herramienta `question`, ya normalizada. */
export type Pregunta = {
  id: string
  sesion: string
  encabezado: string
  pregunta: string
  opciones: string[]
  total: number
}

/**
 * Normaliza un pedido de la herramienta `question`: opencode lo publica como
 * `question.asked` y lo deja pendiente hasta que alguien contesta o lo rechaza.
 * Sin esto, el turno quedaba esperando para siempre.
 */
export function normalizaPregunta(p: any): Pregunta | null {
  const id = String(p?.id ?? "")
  if (!id) return null
  const lista: any[] = Array.isArray(p?.questions) ? p.questions : []
  const primera = lista[0] ?? {}
  const opciones: string[] = Array.isArray(primera.options)
    ? primera.options.map((o: any) => String(o?.label ?? ""))
    : []
  return {
    id,
    sesion: String(p?.sessionID ?? ""),
    encabezado: String(primera.header ?? ""),
    pregunta: String(primera.question ?? ""),
    opciones,
    total: lista.length,
  }
}

/** Cuánto silencio aguantamos antes de dar por colgado el turno. */
const WATCHDOG_MS = Math.max(15_000, Number(process.env.LAIN_WATCHDOG_MS ?? 120_000) || 120_000)

const recorta = (s: string, n = 160): string => (s.length > n ? s.slice(0, n - 1) + "…" : s)

/** Señales de que el problema es la conexión, no el modelo. */
const FALLA_DE_RED = /fetch failed|econnrefused|enotfound|eai_again|etimedout|socket hang up|network|connection (reset|refused|closed)/i

/**
 * Traduce el error del proveedor a algo que se entienda. opencode entrega la
 * causa en `error` (ApiError, ProviderAuthError…), y a veces solo llega un
 * "fetch failed" pelado: aquí se convierte en una frase que dice qué pasó.
 */
export function explainError(err: unknown): string {
  if (!err) return "algo falló y no me dijeron qué"
  const e = err as any
  const name: string = e?.name ?? ""
  const msg: string = String(e?.data?.message ?? e?.message ?? e ?? "")
  const status: number | undefined = e?.data?.statusCode ?? e?.statusCode
  const body: string = String(e?.data?.responseBody ?? e?.responseBody ?? "")
  const todo = `${msg} ${body}`.toLowerCase()
  // undici esconde la causa real en `cause` (p. ej. UND_ERR_HEADERS_TIMEOUT).
  const causa = e?.cause ?? e?.data?.cause ?? e?.error?.cause
  const codigo = String(causa?.code ?? causa?.errno ?? "")
  const conDetalle = (razon: string, extra = msg): string =>
    extra && extra !== razon ? `${razon} · ${recorta(extra.replace(/\s+/g, " "))}` : razon

  if (name === "MessageAbortedError" || /aborted|abort/i.test(msg) && !status) {
    return "lo cortamos antes de que terminara"
  }
  if (name === "ProviderAuthError") {
    return conDetalle(`el proveedor ${e?.data?.providerID ?? ""} te rechazó las credenciales · revisa tu clave con /model`.replace(/\s+/g, " "), msg)
  }
  if (name === "MessageOutputLengthError") {
    return "se le acabó el espacio de salida al modelo (respuesta cortada)"
  }
  if (name === "APIError" || status) {
    if (status === 401 || status === 403 || /unauthorized|invalid api key|forbidden/.test(todo)) {
      return conDetalle(`el proveedor rechazó la clave (${status ?? 401})`, msg)
    }
    if (status === 402 || /insufficient|balance|credit|payment|billing|no credits|out of funds/.test(todo)) {
      return conDetalle("se acabó tu saldo o tu crédito en ese proveedor · cambia de modelo con /model", msg)
    }
    if (status === 429 || /rate limit|too many requests|quota|usage limit|limit reached/.test(todo)) {
      return conDetalle("el proveedor te está limitando (429) · espera un poco o cambia de modelo con /model", msg)
    }
    if (status === 404 || /not found|does not exist|unknown model|no such model/.test(todo)) {
      return conDetalle("ese modelo no existe o no está disponible en tu cuenta · elige otro con /model", msg)
    }
    if (status === 400 && /context|too long|maximum|max tokens|token limit/.test(todo)) {
      return conDetalle("la conversación ya no cabe en ese modelo · prueba /clear o un modelo con más contexto", msg)
    }
    if (status === 400 && /content|policy|moderation|safety/.test(todo)) {
      return conDetalle("el proveedor rechazó el contenido (400) · reformula", msg)
    }
    if (status === 500 || status === 502 || status === 503 || status === 504 || /overload|unavailable|internal error|bad gateway/.test(todo)) {
      return conDetalle(`el proveedor está caído o saturado (${status ?? 503}) · reintenta o cambia de modelo`, msg)
    }
    if (FALLA_DE_RED.test(todo)) {
      return conDetalle("no hay red hacia el proveedor (o no contesta)", codigo ? `${msg} · ${codigo}` : msg)
    }
    return conDetalle(`el proveedor devolvió un error (${status ?? "sin código"})`, msg)
  }
  if (/^UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT$/.test(codigo)) {
    return conDetalle("el servidor de opencode dejó de contestar (el turno se quedó esperando)", codigo)
  }
  if (codigo === "ECONNREFUSED") {
    return conDetalle("el servidor local de opencode no está o se cerró · cerrá y abrí lain", codigo)
  }
  if (FALLA_DE_RED.test(msg)) {
    return conDetalle("no hay red hacia el proveedor (o no contesta)", codigo ? `${msg} · ${codigo}` : msg)
  }
  return recorta(msg.replace(/\s+/g, " ")) || "algo falló y no me dijeron qué"
}

export class Brain {
  private instance: any
  private serverProc: any

  client: any
  sessionId = ""
  handle = "lain"
  private events: BrainEvents
  private idleResolver: (() => void) | null = null
  private textAcc = ""
  private lastTool = ""
  /** tipo de cada parte del mensaje (text, reasoning, tool…) por partID. */
  private partTypes = new Map<string, string>()
  private reasoningNotified = false
  /** Hay una pregunta en vuelo (los deltas fuera de ella se ignoran). */
  private asking = false
  /** El servidor tiene un turno en curso. */
  private running = false
  /** Última señal de vida del turno (delta, parte, herramienta, estado). */
  private lastSignal = 0
  private perro: ReturnType<typeof setInterval> | null = null
  /** URL del servidor local (para la red de seguridad de permisos). */
  private url = ""
  /** Hay un sondeo de permisos en vuelo: no se pisan. */
  private sondeando = false
  private stopReason: "" | "mano" | "watchdog" = ""
  private errEvent = ""
  /** El turno chocó con la cuota del plan gratuito (límite de uso). */
  private limitHit = false
  /** Lo que reportó el proveedor en el turno (para la barra de abajo). */
  private tokIn = 0
  private tokOut = 0
  private tokReason = 0
  private cacheRead = 0
  private costo = 0
  private tStart = 0
  private tFirst = 0
  private tEnd = 0

  constructor(events: BrainEvents = {}) {
    this.events = events
  }

  async start(model?: { providerID: string; modelID: string }, workDir?: string): Promise<void> {
    const port = await freePort()
    // El binario nuevo imprime "server listening on <url>" (antes era
    // "opencode server listening ..."), así que lo lanzamos a mano y nos
    // quedamos con la URL parseando stdout.
    const lainDir = process.env.LAIN_HOME || join(homedir(), ".lain")
    const dataDir = join(lainDir, "opencode-data")
    // El servidor arranca EN la carpeta de trabajo, no en la de lain: así el
    // agente (y cada subagente) crea archivos ahí y no ensucia donde vive lain.
    this.workDir = workDir?.trim() || process.cwd()
    const proc = spawn("opencode.exe", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
      cwd: this.workDir,
      env: { ...process.env, XDG_DATA_HOME: dataDir, OPENCODE_CONFIG_CONTENT: JSON.stringify({}) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.serverProc = proc
    const url = await new Promise<string>((resolve, reject) => {
      const id = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        reject(new Error("Timeout waiting for server to start after 30000ms"))
      }, 30000)
      let output = ""
      let resolved = false
      const onLine = (chunk: Buffer) => {
        if (resolved) return
        output += chunk.toString()
        for (const line of output.split("\\n")) {
          const m = line.match(/server listening on (https?:\/\/[^\\s]+)/)
          if (m) {
            resolved = true
            clearTimeout(id)
            resolve(m[1] as string)
            return
          }
        }
      }
      proc.stdout?.on("data", onLine)
      proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })
      proc.on("exit", (code: number | null) => {
        if (resolved) return
        clearTimeout(id)
        reject(new Error(`Server exited with code ${code}\\n${output.trim()}`))
      })
      proc.on("error", (err: Error) => {
        if (resolved) return
        clearTimeout(id)
        reject(err)
      })
    })
    this.instance = { server: { url, close: () => { try { proc.kill() } catch { /* ignore */ } } } }
    this.url = url
    this.client = createOpencodeClient({ baseUrl: url })
    const session = await this.client.session.create({
      body: { title: `lain :: ${new Date().toISOString().slice(0, 10)}` },
      query: { directory: this.workDir },
    })
    this.sessionId = (session?.data?.id ?? session?.id ?? session?.data?.sessionID) as string
    this.model = model

    const events: any = await this.client.event.subscribe({
      query: { directory: this.workDir },
    })
    void this.consume(events)
  }

  private model?: { providerID: string; modelID: string }
  /** Modelo realmente usado en la última respuesta. */
  usedModel?: { providerID: string; modelID: string }
  /** Subagente (herramienta task) que está corriendo, si lo hay. */
  private subActivo: string | null = null
  /** Permisos ya contestados en este turno: no se contesta dos veces el mismo. */
  private permisosVistos = new Set<string>()
  /** Permisos que no se pudieron contestar: los reintenta el sondeo. */
  private permisosSinContestar = new Map<string, Permiso>()
  /** Preguntas ya vistas: se rechazan una sola vez. */
  private preguntasVistas = new Set<string>()
  /** Preguntas que no se pudieron rechazar: las reintenta el sondeo. */
  private preguntasSinContestar = new Map<string, Pregunta>()
  /** Carpeta donde trabajan lain y sus subagentes (nunca la de instalación). */
  private workDir: string = process.cwd()

  setModel(model?: { providerID: string; modelID: string }): void {
    this.model = model
  }

  /** Carpeta de trabajo actual (para mostrarla con /work). */
  get carpetaDeTrabajo(): string {
    return this.workDir
  }

  /** Lista de proveedores y sus modelos (para el picker). */
  async listModels(): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>> {
    const res: any = await this.client.config.providers()
    const data = res?.data ?? res
    const provs: any[] = data?.providers ?? []
    return provs.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: Object.values(p.models ?? {}).map((m: any) => ({ id: m.id, name: m.name ?? m.id })),
    }))
  }

  private async consume(events: any): Promise<void> {
    const stream = events?.stream ?? events
    try {
      for await (const ev of stream) {
        const p = ev?.properties ?? {}
        // El pedido de permiso puede venir de un subagente (otra sesión) y nadie
        // más lo contesta: se atiende antes del filtro o el turno queda colgado.
        if (esEventoPermiso(ev?.type)) {
          void this.contestaPermiso(p)
          continue
        }
        // La herramienta `question` también espera a que alguien conteste: en
        // una TUI lo hace el usuario; acá no hay quién, así que se rechaza.
        if (ev?.type === "question.asked") {
          void this.contestaPregunta(p)
          continue
        }
        // Solo el trabajo real es señal de vida: esperar un permiso no avanza.
        if (esProgreso(ev?.type)) this.lastSignal = Date.now()
        if (p.sessionID && p.sessionID !== this.sessionId) continue
        switch (ev?.type) {
          case "message.part.delta":
            if (p.field === "text" && typeof p.delta === "string") {
              // Restos de un turno ya cerrado (p. ej. tras cortarlo) no cuentan.
              if (!this.asking) break
              const kind = p.partID ? this.partTypes.get(p.partID) : undefined
              if (kind === "reasoning") {
                if (!this.reasoningNotified) {
                  this.reasoningNotified = true
                  this.events.onReasoning?.()
                }
                break
              }
              if (!this.tFirst) this.tFirst = Date.now()
              this.textAcc += p.delta
              this.events.onDelta?.(p.delta)
            }
            break
          case "message.part.updated": {
            const part = p.part
            if (part?.id && part?.type) this.partTypes.set(part.id, part.type)
            if (part?.type === "tool" && part?.tool && part.tool !== this.lastTool) {
              this.lastTool = part.tool
              this.events.onTool?.(part.tool)
            }
            this.miraSubagente(part)
            break
          }
          case "session.idle":
            this.terminaTurno("idle")
            break
          case "session.status":
            if (String(p?.status?.type ?? "") === "idle") this.terminaTurno("idle")
            break
          case "message.updated": {
            const info = p.info
            const err = info?.error
            if (err) {
              this.errEvent = explainError(err)
              if (looksLikeLimit(err)) this.limitHit = true
            }
            // Los números del proveedor: con esto se arma la barra de abajo.
            const t = info?.tokens
            if (t && typeof t.output === "number") {
              this.tokIn = t.input ?? 0
              this.tokOut = t.output ?? 0
              this.tokReason = t.reasoning ?? 0
              this.cacheRead = t.cache?.read ?? 0
            }
            if (typeof info?.cost === "number") this.costo = info.cost
            break
          }
          case "session.error":
            if (p.error) {
              this.errEvent = explainError(p.error)
              if (looksLikeLimit(p.error)) this.limitHit = true
            }
            break
        }
      }
    } catch {
      /* stream cerrado */
    }
  }

  /**
   * opencode pregunta por cosas fuera de la carpeta de trabajo (el vault, el
   * clon de la Wired) y espera respuesta. En una TUI la das vos; acá no hay a
   * quién preguntar, y sin respuesta el turno quedaba colgado hasta que el SDK
   * se rendía con un "fetch failed".
   */
  private async contestaPermiso(p: any, reintento = false): Promise<void> {
    const perm = normalizaPermiso(p)
    if (!perm) return
    // El aviso sale una sola vez por pedido, aunque después se reintente.
    if (!reintento && this.permisosVistos.has(perm.id)) return
    const respuesta = respondePermiso(perm.tipo)
    if (!reintento) {
      this.permisosVistos.add(perm.id)
      this.events.onPermiso?.({ tipo: perm.tipo, patron: perm.patron, respuesta })
    }
    try {
      const r: any = await this.client.postSessionIdPermissionsPermissionId({
        path: { id: perm.sesion || this.sessionId, permissionID: perm.id },
        query: { directory: this.workDir },
        body: { response: respuesta },
      })
      if (r?.error) throw new Error("opencode no aceptó la respuesta")
    } catch {
      // Se guarda para que el sondeo lo reintente (o el vigilante corte).
      this.permisosSinContestar.set(perm.id, perm)
      return
    }
    this.permisosSinContestar.delete(perm.id)
    // Contestar un permiso sí es avance: el turno sigue, no lo corte el perro.
    this.lastSignal = Date.now()
  }

  /**
   * La herramienta `question` deja el turno esperando una respuesta que lain no
   * puede dar (no hay UI de opciones). Se rechaza: el agente decide por su
   * cuenta o repite la pregunta como texto, y ahí sí la contestás vos.
   */
  private async contestaPregunta(p: any, reintento = false): Promise<void> {
    const q = normalizaPregunta(p)
    if (!q) return
    if (!reintento && this.preguntasVistas.has(q.id)) return
    if (!reintento) {
      this.preguntasVistas.add(q.id)
      this.events.onPregunta?.(q)
    }
    try {
      const r = await fetch(
        `${this.url}/question/${encodeURIComponent(q.id)}/reject?directory=${encodeURIComponent(this.workDir)}`,
        { method: "POST" },
      )
      if (!r.ok && r.status !== 404) throw new Error(`opencode no aceptó el rechazo (${r.status})`)
    } catch {
      this.preguntasSinContestar.set(q.id, q)
      return
    }
    this.preguntasSinContestar.delete(q.id)
    // Rechazarla es avance: el turno sigue, no lo corte el perro.
    this.lastSignal = Date.now()
  }

  /**
   * Red de seguridad: si el evento se pierde (o opencode vuelve a cambiarle el
   * nombre), el servidor igual tiene el pedido pendiente en `GET /permission` y
   * `GET /question`. Se consulta mientras hay turno; es local y barato.
   */
  private async revisaPendientes(): Promise<void> {
    if (!this.url || this.sondeando) return
    this.sondeando = true
    try {
      for (const perm of [...this.permisosSinContestar.values()]) await this.contestaPermiso(perm, true)
      for (const q of [...this.preguntasSinContestar.values()]) await this.contestaPregunta(q, true)
      const dir = encodeURIComponent(this.workDir)
      const rp = await fetch(`${this.url}/permission?directory=${dir}`)
      if (rp.ok) {
        const pendientes: any = await rp.json()
        for (const p of Array.isArray(pendientes) ? pendientes : []) await this.contestaPermiso(p)
      }
      const rq = await fetch(`${this.url}/question?directory=${dir}`)
      if (rq.ok) {
        const preguntas: any = await rq.json()
        for (const q of Array.isArray(preguntas) ? preguntas : []) await this.contestaPregunta(q)
      }
    } catch {
      /* sin servidor o sin red local: el evento sigue siendo el camino normal */
    } finally {
      this.sondeando = false
    }
  }

  /**
   * Detecta un subagente (la herramienta `task`) en el stream y avisa una sola
   * vez por corrida: así el recuadro del composer sabe que hay algo delegado.
   */
  private miraSubagente(part: any): void {
    if (!part || part.type !== "tool" || !part.state) return
    const input = (part.state.input ?? {}) as Record<string, unknown>
    const esSub = part.tool === "task" || typeof input.subagent_type === "string"
    if (!esSub) return
    const id = String(part.id ?? part.callID ?? "")
    const estado: string = part.state.status
    if (estado === "running" || estado === "pending") {
      if (this.subActivo === id) return
      this.subActivo = id
      const descripcion =
        String(input.description ?? "") || String(part.state.title ?? "") || "trabajando"
      const agente = String(input.subagent_type ?? "general")
      const desde = typeof part.state.time?.start === "number" ? part.state.time.start : Date.now()
      this.events.onSubtask?.({ id, descripcion, agente, desde })
    } else if (estado === "completed" || estado === "error") {
      if (this.subActivo !== id) return
      this.subActivo = null
      this.events.onSubtask?.(null)
    }
  }

  /** El servidor cerró el turno: se suelta a quien esté esperando. */
  private terminaTurno(estado: string): void {
    this.running = false
    this.events.onStatus?.(estado)
    this.idleResolver?.()
    this.idleResolver = null
  }

  /**
   * La última respuesta del asistente de este turno (texto final, modelo y
   * error). Se descartan las viejas: si el turno no dijo nada, no queremos
   * devolver la respuesta anterior.
   */
  private async ultimaRespuesta(desde: number): Promise<any | null> {
    try {
      const r: any = await this.client.session.messages({
        path: { id: this.sessionId },
        query: { directory: this.workDir },
      })
      const lista: any[] = r?.data ?? r
      if (!Array.isArray(lista)) return null
      for (let i = lista.length - 1; i >= 0; i--) {
        const info = lista[i]?.info
        if (info?.role !== "assistant") continue
        const creado = Number(info?.time?.created ?? 0)
        // Relojes del mismo equipo: un segundo de margen alcanza.
        if (creado && creado < desde - 1000) return null
        return lista[i]
      }
    } catch {
      /* si no se puede, queda lo que llegó por el stream */
    }
    return null
  }

  /** Inyecta contexto de sistema sin provocar respuesta. Captura el modelo resuelto. */
  async prime(systemText: string): Promise<void> {
    const res: any = await this.client.session.prompt({
      path: { id: this.sessionId },
      query: { directory: this.workDir },
      body: { noReply: true, parts: [{ type: "text", text: systemText }] },
    })
    const info = res?.data?.info ?? res?.info
    this.captureModel(info)
  }

  /**
   * Arranca un turno: la barra de abajo vuelve a cero (y queda visible) hasta
   * que lleguen los primeros datos.
   */
  empiezaTurno(): void {
    this.tStart = Date.now()
    this.tEnd = 0
    this.tFirst = 0
    this.tokIn = 0
    this.tokOut = 0
    this.tokReason = 0
    this.cacheRead = 0
    this.textAcc = ""
    this.limitHit = false
  }

  /** Guarda el modelo que opencode resolvió (p. ej. el free por defecto). */
  private captureModel(info: any): void {
    const m = info?.model ?? info
    if (m?.providerID && m?.modelID) {
      this.usedModel = { providerID: m.providerID, modelID: m.modelID }
    }
  }

  /** Manda un prompt y espera la respuesta completa, emitiendo deltas. */
  async ask(text: string): Promise<string> {
    this.asking = true
    try {
      for (let intento = 0; ; intento++) {
        this.textAcc = ""
        this.lastTool = ""
        this.reasoningNotified = false
        this.partTypes.clear()
        this.permisosVistos.clear()
        this.permisosSinContestar.clear()
        this.preguntasVistas.clear()
        this.preguntasSinContestar.clear()
        this.aborted = false
        this.stopReason = ""
        this.errEvent = ""
        this.limitHit = false
        this.tokIn = 0
        this.tokOut = 0
        this.tokReason = 0
        this.cacheRead = 0
        this.tStart = Date.now()
        this.tFirst = 0
        this.tEnd = 0
        this.lastSignal = Date.now()
        this.armaPerro()
        const antes = Date.now()
        const body: any = { parts: [{ type: "text", text }] }
        if (this.model) body.model = this.model
        const cut = new Promise<void>((r) => (this.cutResolver = r))
        // prompt_async contesta enseguida; el turno (texto, herramientas,
        // errores) llega por /event y termina con session.idle. El prompt
        // sincrónico esperaba todo el turno y a los 5 minutos moría con
        // UND_ERR_HEADERS_TIMEOUT (undici corta si no llegan cabeceras).
        const dormido = new Promise<void>((r) => (this.idleResolver = r))
        this.running = true
        let err = ""
        const enviado: any = await this.client.session
          .promptAsync({ path: { id: this.sessionId }, query: { directory: this.workDir }, body })
          .catch((e: unknown) => {
            err = explainError(e)
            if (looksLikeLimit(e)) this.limitHit = true
            return null
          })
        if (enviado === null || enviado?.error) {
          this.cutResolver = null
          this.idleResolver = null
          this.errText = err || explainError(enviado?.error) || "no pude mandar el turno"
          throw new Error(this.errText)
        }
        await Promise.race([dormido, cut])
        this.cutResolver = null
        this.idleResolver = null
        if (this.aborted) {
          // Cortado (a mano o por el vigilante): nos quedamos con lo que haya.
          this.errText = ""
          return this.textAcc.trim()
        }
        // La última parte puede llegar por el stream un pelín después de idle.
        await new Promise((r) => setTimeout(r, 150))
        const res: any = await this.ultimaRespuesta(antes)
        const infoErr = res?.info?.error
        if (infoErr && looksLikeLimit(infoErr)) this.limitHit = true
        const razon = infoErr ? explainError(infoErr) : this.errEvent
        const fromParts = extractText(res)
        const vacio = fromParts.trim() === "" && this.textAcc.trim() === ""
        if (vacio && razon) {
          // No dijo nada y sabemos por qué: eso es lo que hay que contar.
          this.errText = razon
          throw new Error(this.errText)
        }
        // Tras un aborto el servidor puede devolver un turno viejo vacío al
        // instante y quedarse con el nuestro: esperamos a que se asiente y
        // preguntamos otra vez, una sola vez.
        if (vacio && intento === 0 && Date.now() - antes < 700) {
          this.tEnd = 0
          await this.waitIdle(3000)
          continue
        }
        const acc = this.textAcc
        const out = fromParts.trim().length >= acc.trim().length ? fromParts : acc
        this.captureModel(res?.info)
        // Hubo error pero algo alcanzó a decir: se queda el texto y se avisa.
        this.errText = razon
        return out.trim()
      }
    } finally {
      this.asking = false
      this.running = false
      this.cutResolver = null
      this.tEnd = Date.now()
      this.desarmaPerro()
      // Turno cerrado (terminara bien o mal): no queda un subagente en el recuadro.
      this.subActivo = null
      this.events.onSubtask?.(null)
    }
  }

  /**
   * Tokens del turno y a qué velocidad salen, para la barra de abajo.
   * Mientras el turno está abierto la cuenta es una estimación por caracteres
   * (unos 4 por token); cuando el proveedor reporta los suyos, manda él.
   */
  metrics(): {
    tokIn: number
    tokOut: number
    tokReason: number
    cacheRead: number
    costo: number
    ms: number
    tps: number
    chars: number
    live: boolean
  } {
    // "En curso" solo si hay un turno abierto de verdad (tStart se pone al preguntar).
    const live = this.tEnd === 0 && this.tStart !== 0
    const chars = this.textAcc.length
    const tokOut = this.tokOut > 0 ? this.tokOut : Math.round(chars / 4)
    const desde = this.tFirst || this.tStart || Date.now()
    const ms = Math.max(0, (live ? Date.now() : this.tEnd) - desde)
    // Con menos de medio segundo el cálculo es ruido: mejor no mostrar número.
    const tps = ms < 500 ? 0 : (tokOut / ms) * 1000
    return { tokIn: this.tokIn, tokOut, tokReason: this.tokReason, cacheRead: this.cacheRead, costo: this.costo, ms, tps, chars, live }
  }

  /**
   * Vigilante: si el turno lleva mucho rato sin dar señales (típico: una
   * herramienta que no vuelve), lo corta solo para que la sesión no se quede
   * muda. Se puede ajustar con LAIN_WATCHDOG_MS.
   */
  private armaPerro(): void {
    this.desarmaPerro()
    this.perro = setInterval(() => void this.latido(), 5_000)
  }

  /**
   * Un latido del vigilante: primero mira si hay un permiso esperando (y lo
   * contesta), después decide si el turno se quedó sin señales. En ese orden,
   * porque un permiso sin contestar era justamente lo que colgaba todo.
   */
  private async latido(): Promise<void> {
    if (!this.asking || this.aborted) return
    await this.revisaPendientes()
    if (!this.asking || this.aborted) return
    if (Date.now() - this.lastSignal > WATCHDOG_MS) await this.colgado()
  }

  private desarmaPerro(): void {
    if (this.perro) clearInterval(this.perro)
    this.perro = null
  }

  /** El vigilante corta el turno (a diferencia de ctrl+x, fue solo). */
  private async colgado(): Promise<void> {
    if (this.aborted) return
    this.desarmaPerro()
    this.stopReason = "watchdog"
    this.aborted = true
    try {
      await (this.client as any).session.abort({ path: { id: this.sessionId }, query: { directory: this.workDir } })
    } catch {
      /* seguimos: la red de seguridad nos desbloquea igual */
    }
    await this.waitIdle(2500)
    this.cutResolver?.()
  }

  /**
   * Frena el turno en curso: pide al servidor que aborte y, si no contesta,
   * desbloquea igual para que puedas seguir escribiendo.
   */
  async abort(): Promise<void> {
    if (this.aborted) return
    this.stopReason = "mano"
    this.aborted = true
    this.desarmaPerro()
    try {
      await (this.client as any).session.abort({ path: { id: this.sessionId }, query: { directory: this.workDir } })
    } catch {
      /* seguimos: la red de seguridad de abajo nos desbloquea igual */
    }
    // No soltamos el turno hasta que el servidor dé la corrida por terminada:
    // si preguntas otra vez antes, contesta a la vieja y todo se descuadra.
    await this.waitIdle(2500)
    this.cutResolver?.()
  }

  /** Espera a que el servidor cierre el turno en curso (con tope de tiempo). */
  private async waitIdle(maxMs: number): Promise<void> {
    if (!this.running) return
    await new Promise<void>((resolve) => {
      let hecho = false
      const fin = (): void => {
        if (hecho) return
        hecho = true
        clearTimeout(t)
        if (this.idleResolver === fin) this.idleResolver = null
        resolve()
      }
      const t = setTimeout(fin, maxMs)
      this.idleResolver = fin
    })
  }

  private aborted = false
  private cutResolver: (() => void) | null = null
  private errText = ""

  /** Último error del servidor, si hubo. */
  get lastError(): string {
    return this.errText
  }

  /** El último turno chocó con la cuota del plan gratuito. */
  get hitLimit(): boolean {
    return this.limitHit
  }

  /** Quién cortó el último turno: "mano" (ctrl+x), "watchdog" (solo) o "". */
  get lastStop(): "" | "mano" | "watchdog" {
    return this.stopReason
  }

  async stop(): Promise<void> {
    try {
      await this.instance?.server?.close()
    } catch {
      /* ignore */
    }
    try {
      this.serverProc?.kill()
    } catch {
      /* ignore */
    }
  }
}

function extractText(res: any): string {
  const parts = res?.data?.parts ?? res?.parts ?? []
  return (parts as any[])
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("")
}
