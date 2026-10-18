# Contribuir a lain

Gracias por pasar. Antes de mandar un PR, esto es lo que conviene saber.

## Poner el entorno en marcha

```bash
git clone https://github.com/itsmaybetokyo/lain
cd lain
npm install
npm run lain
```

Necesitás **Node 20+** y el **CLI de `opencode`** en el `PATH`. Para jugar sin tocar tu
instalación real, aislá todo con `LAIN_HOME`:

```bash
LAIN_HOME=./.lain npm run lain        # Bash
$env:LAIN_HOME="./.lain"; npm run lain  # PowerShell
```

## Correr las pruebas

```bash
npm test          # typecheck + smoke
npm run typecheck # tsc --noEmit (incluye src/ y scripts/)
npm run smoke     # prueba de humo del vault y de la Wired
```

`scripts/smoke.mts` se aísla solo: crea un `LAIN_HOME` temporal y levanta el relay en un
puerto libre, así que no toca tu `~/.lain` ni tu vault. Si escribís pruebas nuevas,
respetá lo mismo.

### La regla de oro

**No corras pruebas que hablen con el modelo.** Arrancar el agente y esperar una respuesta
puede colgarse minutos; no es algo que un test deba hacer. Todo lo verificable se verifica
sin el modelo: las funciones puras con aserciones, la TUI rejugando el stream ANSI, el
vault y la Wired contra el relay local.

Para ver la interfaz sin arrancar opencode:

```bash
npm run preview:art    # el retrato, en sus tres modos
npm run preview:tui    # un fotograma completo de la pantalla
```

## Mapa del código

| archivo | de qué se ocupa |
| --- | --- |
| `src/index.ts` | el REPL: comandos, arranque, prompt de sistema, orquestación |
| `src/tui.ts` | la pantalla: render, input, historial, autocompletado, recuadro de subagente |
| `src/mascot.ts` | el retrato de Lain (braille, medios bloques, bloques) |
| `src/theme.ts` | colores ANSI, `paint`, recorte de texto visible |
| `src/md.ts` | markdown mínimo para la terminal |
| `src/brain.ts` | la conversación con opencode: sesión, streaming, subagentes, cuota |
| `src/avisos.ts` | los avisos de la Wired apilados y su animación |
| `src/bar.ts` | la barra de abajo: wired · tokens · entropía · límite |
| `src/config.ts` | `~/.lain/config.json`, identidad, carpeta de trabajo |
| `src/update.ts` | chequeo de commits nuevos y `git pull` con dependencias |
| `src/install.ts` | el comando `lain` en el PATH (lanzador + PATH del usuario) |
| `src/vault.ts` | las notas de Obsidian y el índice local |
| `src/tts.ts`, `src/sound.ts` | voz enchufable y sonidos |
| `src/local.ts` | el faro local (ciudad, hora, titulares) |
| `src/mux.ts` | integración con psmux/tmux |
| `src/limit.ts` | la cuota gratuita de opencode |
| `src/wired/protocol.ts` | Protocolo 7: la unidad de conocimiento que viaja |
| `src/wired/backend.ts` | elige el transporte (git o relay) |
| `src/wired/git.ts` | la federación por repo git |
| `src/wired/server.ts` | el relay local (`npm run wired`) |
| `src/wired/client.ts` | el cliente HTTP del relay |
| `src/wired/entropy.ts` | la entropía global |

## Estilo

- TypeScript estricto, con `noUncheckedIndexedAccess`: nada de `any` salvo en el borde
  con el SDK de opencode.
- Los comentarios y los textos de la interfaz van **en español**, en el tono de lain.
- Cada comando del REPL tiene su fila en `HELPROWS` (`src/index.ts`) y su bloque de
  handler; si agregás uno, agregá las dos cosas y, si tiene sentido, un alias en español.
- Nada de dependencias nuevas sin una buena razón: hoy el proyecto es
  `@opencode-ai/sdk` y poco más.
- No escribas en `~/.lain` desde el código de arranque salvo a través de `config.ts`.

## Antes de abrir el PR

1. `npm test` en verde.
2. Si tocaste la interfaz, mostrá un `preview` en la descripción del PR.
3. Un cambio por PR, con un mensaje que explique el *por qué*, no solo el *qué*.
