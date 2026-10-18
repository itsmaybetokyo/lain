# lain

> *«¿Por qué estás tan interesada en la computadora, Lain?»*
> *«Porque ahí vive todo el mundo.»*

`lain` es una CLI que vive en tu terminal. Te recibe con un retrato de **Lain** dibujado
en caracteres —braille suavizado, medios bloques o bloques— y conversa con vos a través
de **opencode**. Cada intercambio queda guardado en un vault de **Obsidian** como una nota
llena de `[[wikilinks]]`, así que con el tiempo tu conocimiento arma un grafo que podés
mirar. Y ese grafo no queda solo: los nodos se federan en **la Wired** (Protocolo 7).

- **El retrato** respira: parpadea, glitchea cuando el modelo piensa, y debajo se apilan
  los avisos de lo que publican los demás nodos (escritos carácter por carácter).
- **La conversación** es markdown bien renderizado, letra por letra, con un recuadro
  cuando lain delega en un subagente.
- **El conocimiento** vive en notas con wikilinks; `/publish` lo sube a la Wired,
  `/sync` baja lo de otros, `/search` busca en todo, y `/entropia` dice cuánto se piensa
  la Wired a sí misma.
- **La voz** es opcional y enchufable: `TTS` queda en silencio salvo que le des un motor
  con `/voice`. Los sonidos de aviso y de tecleo se apagan con `/sound` y `/typing`.

## Estado

Hoy es **Windows-first**. Lanzar el agente usa `opencode.exe`, el sonido y la voz usan
PowerShell + WPF, y el panel lateral se integra con psmux/tmux. El resto —vault,
protocolo, Wired, tests— es portable, y los aportes para Linux/macOS son bienvenidos
(ver [CONTRIBUTING.md](CONTRIBUTING.md)).

## Requisitos

- **Node 20+**
- El **CLI de `opencode`** instalado y disponible en el `PATH`.
- (Windows) PowerShell 5.1+, que ya viene con el sistema.
- Opcional: **Obsidian**, para abrir el vault con `/vault`.

## Instalación

```bash
git clone https://github.com/itsmaybetokyo/lain
cd lain
npm install
npm run lain          # o: node bin/lain.mjs
```

En el primer arranque se crea `~/.lain` (o donde apunte `LAIN_HOME`):

```
~/.lain/
  config.json      tu identidad (nodeId, handle), modelo, preferencias
  vault/           tu vault de Obsidian; las notas de la Wired van en WIRED/
  opencode-data/   datos de opencode, aislados de los tuyos
  work/            carpeta de trabajo de lain y sus subagentes
  wired-repo/      clon del repo de la Wired
  update.json      cuándo miramos por última vez si hay commits nuevos
```

Nada de eso se versiona. Para probar sin ensuciar tu instalación real: `LAIN_HOME=./.lain`.

## Uso

Dentro del REPL:

| comando | qué hace |
| --- | --- |
| `<texto>` | hablás con lain; responde opencode y queda guardado como nota |
| `/help` | la lista de comandos |
| `/model` | elegís proveedor y modelo (se recuerda) |
| `/art` | cambiás el retrato: suave / compacto / completo |
| `/vault` | abrís tu vault de Obsidian |
| `/whoami` | tu identidad de nodo y qué estás almacenando |
| `/publish [--last N]` | subís tu conocimiento a la Wired (todo o los últimos N) |
| `/search <q>` | buscás en el conocimiento global |
| `/sync` | bajás el conocimiento de otros nodos a tu vault (`WIRED/nodes`) |
| `/local [ciudad]` | la hora y un par de titulares de tu ciudad |
| `/entropia` | cómo está la entropía global de la Wired |
| `/wired [git <repo> \| relay]` | estado y transporte de la Wired |
| `/update` | busca commits nuevos de lain y se pone al día |
| `/install` · `/uninstall` | deja (o saca) el comando «lain» en tu PATH |
| `/work [ruta]` | dónde crean archivos lain y sus subagentes |
| `/mouse` | cedés (o devolvés) la rueda del mouse al multiplexor |
| `/voice <cmd>` · `/mute` · `/unmute` | motor de voz, silenciar, encender |
| `/sound` · `/typing` | sonido de aviso y de tecleo |
| `ctrl+x` | frenás la respuesta en curso |
| `/clear` · `/exit` | limpiar el chat · desconectar |

Y desde la terminal, sin entrar al REPL:

```bash
lain help                       # la ayuda
lain whoami                     # tu nodo
lain models                     # proveedores y modelos disponibles
lain vault                      # abre el vault
lain search <q>                 # busca en la Wired
lain publish                    # publica
lain sync                       # sincroniza
lain install                    # deja el comando «lain» en tu PATH
lain uninstall                  # lo saca
lain update                     # busca commits nuevos y se actualiza
lain wired [puerto]             # levanta el relay local
lain wired git [repo]           # usa un repo git como Wired
lain --model <prov>/<modelo>    # arranca con un modelo puntual
```

## Tenerlo como comando

Para escribir `lain` desde cualquier carpeta, una sola vez:

```bash
npm run lain -- install     # equivalente a `lain install` una vez instalado
```

Eso deja un lanzador en `%LOCALAPPDATA%\lain\bin\lain.cmd` (Windows) o en
`~/.local/bin/lain` (Linux/macOS) y agrega esa carpeta al PATH de tu usuario
(por el registro, respetando los `%VARIABLES%` que ya tuvieras ahí). Abrí una
terminal nueva y listo; `lain uninstall` lo deshace. Si preferís no tocar el PATH:
`lain install --no-path` te dice qué agregar a mano.

El lanzador apunta al checkout, así que actualizarte no lo rompe.

## Actualizarse

```bash
lain update            # o /update, adentro de lain
```

Mira qué hay arriba con `git fetch` + `git rev-list`, te muestra el asunto de cada
commit que falta, hace `git pull --ff-only` y, si el pull tocó `package.json` o el
lockfile, corre `npm install`. Si tenés cambios sin commitear, avisa antes.

Además, al arrancar, lain mira el remoto **una vez por día** en segundo plano
(queda anotado en `~/.lain/update.json`) y, si hay commits nuevos, te deja una
línea en el chat. Si tu clon tiene commits propios, el `--ff-only` se va a negar y
te lo dice: eso lo resolvés vos.

## La Wired (Protocolo 7)

La Wired es el índice global: cada nodo publica lo suyo y lee lo de los demás.
Por defecto se usa un **repo git compartido**:

```
https://github.com/itsmaybetokyo/wired
```

Leer alcanza con que el repo sea público; **publicar** requiere ser colaborador del repo.
Si querés tu propia federación, apuntá lain a donde quieras:

```
/wired git https://github.com/tu-usuario/tu-wired
```

También hay un **relay** HTTP simple (el mismo protocolo, sin git), útil para una red
local o para probar:

```bash
npm run wired              # relay en http://127.0.0.1:7777
```

```
/wired relay               # el nodo apunta a ese relay
```

Qué se publica lo decide la política `publish` del `config.json`
(`private` / `public` / `all`) y, cuando querés, `/publish`. Ojo: el repo de la Wired es
público, así que lo que subas —tu handle y el texto de las notas— queda a la vista de todos.

## Carpeta de trabajo

lain y sus subagentes crean y editan archivos **fuera** de donde vive el programa. Por
defecto, en `~/.lain/work`; se cambia con `/work <ruta>` o con la variable de entorno
`LAIN_WORKDIR`. Así un subagente que arma un proyecto no ensucia el repo de lain.

## Tests

```bash
npm test          # typecheck + smoke
npm run typecheck
npm run smoke
```

El *smoke* se aísla en una carpeta temporal y levanta el relay en un puerto libre:
**no toca tu `~/.lain` ni tu vault, y no habla con el modelo**. Las previsualizaciones,
que tampoco hablan con el modelo, se dibujan con `npm run preview:art` y
`npm run preview:tui`.

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

[MIT](LICENSE).
