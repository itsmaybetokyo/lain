import { C, paint } from "./theme.js";

/** Retrato de Lain en bloques (fuente binaria ~54x30). */
const ART = [
  "          ████████████████████████████",
  "        ████████████████████████████████",
  "      ███████████████████████████████████",
  "    ██████████████████████████████████████",
  "   ████████████████████████████████████████",
  "   █████████████████████████████████████████",
  "  ██████████████████████████████████████████",
  "  ███████████████████████████████████████████",
  " ██████████████████   ███████████████████████",
  " ██████████████████    ██████████████████████",
  " ████████████████      ██████████████████████",
  " ██████████ █████       ████ ████████████████",
  " ██████████ █████       ████ ████████████████",
  " █████████                          █████████",
  " ████████  █████              ████  █████████",
  " ██████ █                             ██████",
  "  █████                              █ ███ █",
  "   █████                             ███ ███",
  "    ██████                          ██ ██ ██",
  "    ███████                         ██████ ",
  "    ████████                       ███████",
  "      ████████                   █████████",
  "      ██████████               ██████████",
  "               █                █ ███████",
  "                                   █████",
  "                                   █████",
  "                                   █████",
  "          ██                       ████",
  "      ████████                     ███████",
  " ██        █████████           ████████   ████",
];

export type ArtMode = "smooth" | "half" | "full";

const GL = "▓▒░▓█▚▞╳░▒";

interface Src {
  grid: number[][];
  w: number;
  h: number;
}

function source(): Src {
  const trimmed = ART.map((r) => r.replace(/\s+$/, ""));
  const h = trimmed.length;
  const w = trimmed.reduce((m, r) => Math.max(m, r.length), 0);
  const grid = trimmed.map((r) => {
    const row: number[] = [];
    for (let c = 0; c < w; c++) row.push(r[c] === "█" ? 1 : 0);
    return row;
  });
  return { grid, w, h };
}

const SRC = source();

/** Filas de celda objetivo: el retrato queda algo más alto que ancho. */
const CELL_ROWS = 20;

/** Muestreo bilineal de la fuente en coordenadas continuas. */
function at(px: number, py: number): number {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const g = (ix: number, iy: number): number =>
    iy >= 0 && iy < SRC.h && ix >= 0 && ix < SRC.w ? SRC.grid[iy]![ix]! : 0;
  return (
    g(x0, y0) * (1 - fx) * (1 - fy) +
    g(x0 + 1, y0) * fx * (1 - fy) +
    g(x0, y0 + 1) * (1 - fx) * fy +
    g(x0 + 1, y0 + 1) * fx * fy
  );
}

/** Centro en la fuente de la sub-fila `j` de `sub` sub-filas. */
function subRowY(j: number, sub: number): number {
  return (j + 0.5) * (SRC.h / sub) - 0.5;
}

/**
 * Braille (2x4 puntos por celda) sobre la fuente reescalada y suavizada.
 * Los puntos braille son cuadrados, así que se estira en vertical para
 * llegar a `CELL_ROWS` filas sin que quede aplastada.
 */
function brailleRows(): string[] {
  const sx = 2;
  const sub = CELL_ROWS * 4;
  const rows: string[] = [];
  for (let cy = 0; cy < CELL_ROWS; cy++) {
    let line = "";
    for (let cx = 0; cx < Math.ceil((SRC.w * sx) / 2); cx++) {
      let bits = 0;
      const dot = (dx: number, dy: number, bit: number): void => {
        const px = (cx * 2 + dx + 0.5) / sx - 0.5;
        if (at(px, subRowY(cy * 4 + dy, sub)) >= 0.5) bits |= bit;
      };
      dot(0, 0, 0x01);
      dot(0, 1, 0x02);
      dot(0, 2, 0x04);
      dot(0, 3, 0x40);
      dot(1, 0, 0x08);
      dot(1, 1, 0x10);
      dot(1, 2, 0x20);
      dot(1, 3, 0x80);
      line += bits ? String.fromCharCode(0x2800 + bits) : " ";
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

/** Medios bloques (▀ ▄ █) sobre la misma rejilla alta, para que no aplaste. */
function halfRows(): string[] {
  const sub = CELL_ROWS * 2;
  const out: string[] = [];
  for (let cy = 0; cy < CELL_ROWS; cy++) {
    let line = "";
    for (let cx = 0; cx < SRC.w; cx++) {
      const t = at(cx, subRowY(cy * 2, sub)) >= 0.5;
      const b = at(cx, subRowY(cy * 2 + 1, sub)) >= 0.5;
      line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

function fullRows(): string[] {
  return ART.map((r) => r.replace(/\s+$/, ""));
}

export function artRows(mode: ArtMode = "smooth"): string[] {
  if (mode === "full") return fullRows();
  if (mode === "half") return halfRows();
  return brailleRows();
}

function glitchRow(r: string, row: number, amount: number): string {
  if (amount <= 0) return r;
  const arr = [...r];
  for (let k = 0; k < 3; k++) {
    const idx = (amount * 31 + k * 47 + row * 7) % Math.max(1, arr.length);
    if (arr[idx] && arr[idx] !== " " && arr[idx] !== "\u2800") {
      arr[idx] = GL[(amount + k * 3) % GL.length]!;
    }
  }
  return arr.join("");
}

/** Todo el retrato en un solo tono. */
export const ART_COLOR = C.magenta;

export interface MascotState {
  glitch?: number;
  say?: string;
  mode?: ArtMode;
}

/** Arte de Lain listo para imprimir. Mismo número de líneas por modo. */
export function mascot(state: MascotState = {}): string {
  const rows = artRows(state.mode ?? "smooth");
  const colored = rows.map((r, i) =>
    paint(ART_COLOR, glitchRow(r, i, state.glitch ?? 0)),
  );
  const caption = state.say ? paint(C.brcyan, `  ◈ ${state.say}`) : " ";
  return ["", ...colored, caption].join("\n");
}

export function mascotLines(mode: ArtMode = "smooth"): number {
  return 1 + artRows(mode).length + 1;
}

/** Cabecera de arranque. */
export function banner(): string {
  const r = paint(C.brmagenta, "▓▒░");
  const title = paint(C.bold + C.brcyan, "  l a i n  ");
  const sub = paint(C.gray, ":: the wired is everywhere and nowhere");
  return `\n${r} ${title}${sub}\n`;
}
