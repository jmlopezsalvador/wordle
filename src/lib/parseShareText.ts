export type ParsedShare = {
  gameRaw: string;
  gameKey: "wordle" | "frase_del_dia" | "unknown";
  edition: number;
  attempts: number;
  maxAttempts: number;
  isFailure: boolean;
  gridRows: string[];
  hardMode?: boolean;
};

const HEADER_REGEX = /^(?<game>[^\d\n\r#]+?)\s*#?\s*(?<edition>\d[\d.,]*)\s+(?<result>[1-9]\d*|X)\/(?<max>\d+)(?<hard>\*)?$/i;
const GRID_LINE_REGEX = /^[⬛⬜🟨🟩🟦🟪🟥🟧]+$/u;

function normalizeGameKey(gameRaw: string): ParsedShare["gameKey"] {
  const g = gameRaw.trim().toLowerCase();
  if (g.includes("wordle")) return "wordle";
  if (g.includes("frase")) return "frase_del_dia";
  return "unknown";
}

export function parseShareText(input: string): ParsedShare {
  const lines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("Texto vacio.");
  }

  let headerIndex = -1;
  let headerMatch: RegExpMatchArray | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(HEADER_REGEX);
    if (m?.groups) {
      headerIndex = i;
      headerMatch = m;
      break;
    }
  }

  if (!headerMatch?.groups || headerIndex < 0) {
    throw new Error("Formato invalido. Cabecera no reconocida.");
  }

  const gameRaw = headerMatch.groups.game.trim();
  const edition = Number(headerMatch.groups.edition.replace(/[.,]/g, ""));
  const resultRaw = headerMatch.groups.result.toUpperCase();
  const maxAttempts = Number(headerMatch.groups.max);
  const hardMode = Boolean(headerMatch.groups.hard);

  if (!Number.isFinite(edition) || !Number.isFinite(maxAttempts)) {
    throw new Error("No se pudo parsear edicion o maximo de intentos.");
  }

  const isFailure = resultRaw === "X";
  const attempts = isFailure ? maxAttempts + 1 : Number(resultRaw);

  if (!isFailure && (attempts < 1 || attempts > maxAttempts)) {
    throw new Error("Intentos fuera de rango.");
  }

  const gridRows = lines.slice(headerIndex + 1).filter((line) => GRID_LINE_REGEX.test(line));
  if (gridRows.length === 0) {
    throw new Error("No se detecto cuadricula de emojis.");
  }

  return {
    gameRaw,
    gameKey: normalizeGameKey(gameRaw),
    edition,
    attempts,
    maxAttempts,
    isFailure,
    gridRows,
    hardMode
  };
}
