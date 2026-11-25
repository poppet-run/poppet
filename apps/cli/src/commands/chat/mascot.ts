export type MascotExpression =
  | "friendly"
  | "happy"
  | "wink"
  | "thinking"
  | "blink"
  | "excited"
  | "surprised"
  | "focused"
  | "oops";

export type MascotColorMode = "truecolor" | "256";

export const launchMascotExpressions: ReadonlyArray<MascotExpression> = [
  "friendly",
  "happy",
  "wink",
  "thinking",
  "blink",
  "excited",
  "surprised",
  "focused",
];

export const mascotWidth = 21;

type Rgb = readonly [number, number, number];

const escape = "\u001b[";
const reset = `${escape}0m`;

const baseRows: ReadonlyArray<string> = [
  "............AAA......",
  "........AAAAAAAA.....",
  ".AAAAAAAAAAAAAAA.....",
  "AAAAAAAANNNNNNNAA....",
  ".AAAAANNNNNNNNNNA....",
  ".AOAOANNNNNNNNNNA.H.H",
  ".AAOAANNNNNNNNNNA.HHH",
  ".AOAOANNNNNNNNNNA.HHH",
  ".AAAAANNNNNNNNNAA.HH.",
  "..OOOAAAAAAAAAAA.HH..",
  ".OHHHO...............",
  "COHHHOCCCCCCCCCCCC...",
  "CCOOOCCCCC" + "CCCCCCCC...",
  ".CCCCCCCCCCCCCCCC....",
  "..CCCCCCCCCCCCCC.....",
  "....CCCCCCCCCC.......",
];

type FaceOverlay = readonly [string, string, string, string, string, string];

const faceOverlays: Readonly<Record<MascotExpression, FaceOverlay>> = {
  friendly: ["..........", ".......EE.", ".EE....EE.", ".EE.......", "....EE....", ".........."],
  happy: ["..........", ".......E..", "..E...E.E.", ".E.E.....B", "B...EE....", ".........."],
  wink: ["..........", "........E.", ".EE....E..", ".EE.....E.", "....EE....", ".........."],
  thinking: ["..........", "...EE..EE.", "...EE..EE.", "..........", ".....EE...", ".........."],
  blink: ["..........", "..........", "......EEE.", ".EEE......", "....EE....", ".........."],
  excited: ["..........", "..E....E..", ".EEE..EEE.", "..E....E..", "....EE....", ".........."],
  surprised: ["..........", ".EE....EE.", ".EE....EE.", "....EE....", "....EE....", ".........."],
  focused: ["..........", "......DDD.", ".DDD..EEE.", ".EEE......", "....EE....", ".........."],
  oops: ["..........", ".E.E..E.E.", "..E....E..", ".E.E..E.E.", "....EE....", ".........."],
};

const clampChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const lerpRgb = (from: Rgb, to: Rgb, ratio: number): Rgb => [
  clampChannel(from[0] + (to[0] - from[0]) * ratio),
  clampChannel(from[1] + (to[1] - from[1]) * ratio),
  clampChannel(from[2] + (to[2] - from[2]) * ratio),
];

const apricotHighlight: Rgb = [255, 204, 168];
const apricotBrand: Rgb = [255, 180, 138];
const apricotShadow: Rgb = [238, 150, 112];
const handHighlight: Rgb = [255, 194, 155];
const handShadow: Rgb = [239, 152, 114];
const navyHighlight: Rgb = [35, 50, 80];
const navyShadow: Rgb = [22, 32, 54];
const navyOutline: Rgb = [25, 36, 58];
const creamHighlight: Rgb = [255, 246, 232];
const creamShadow: Rgb = [235, 216, 190];
const eyeApricot: Rgb = [255, 201, 164];
const blushCoral: Rgb = [244, 125, 139];
const lidApricot: Rgb = [201, 133, 102];

const pixelColor = (
  code: string,
  column: number,
  row: number,
  width: number,
  height: number,
): Rgb | null => {
  const nx = width > 1 ? column / (width - 1) : 0;
  const ny = height > 1 ? row / (height - 1) : 0;

  if (code === "A") {
    const ratio = Math.max(0, Math.min(1, ny * 0.8 + nx * 0.2));

    return ratio < 0.45
      ? lerpRgb(apricotHighlight, apricotBrand, ratio / 0.45)
      : lerpRgb(apricotBrand, apricotShadow, (ratio - 0.45) / 0.55);
  }

  if (code === "H") {
    return lerpRgb(handHighlight, handShadow, Math.max(0, Math.min(1, ny)));
  }

  if (code === "E") {
    return eyeApricot;
  }

  if (code === "B") {
    return blushCoral;
  }

  if (code === "D") {
    return lidApricot;
  }

  if (code === "N") {
    const ratio = Math.max(0, Math.min(1, ny * 0.85 + nx * 0.15));

    return lerpRgb(navyHighlight, navyShadow, ratio);
  }

  if (code === "O") {
    return navyOutline;
  }

  if (code === "C") {
    const ratio = Math.max(0, Math.min(1, (ny - 0.62) / 0.38));

    return lerpRgb(creamHighlight, creamShadow, ratio);
  }

  return null;
};

const cubeLevels = [0, 95, 135, 175, 215, 255] as const;

const nearestXterm256 = (rgb: Rgb): number => {
  let best = 16;
  let bestDistance = Infinity;

  for (const [red, redLevel] of cubeLevels.entries()) {
    for (const [green, greenLevel] of cubeLevels.entries()) {
      for (const [blue, blueLevel] of cubeLevels.entries()) {
        const dr = rgb[0] - redLevel;
        const dg = rgb[1] - greenLevel;
        const db = rgb[2] - blueLevel;
        const distance = dr * dr + dg * dg + db * db;

        if (distance < bestDistance) {
          bestDistance = distance;
          best = 16 + 36 * red + 6 * green + blue;
        }
      }
    }
  }

  for (let step = 0; step < 24; step++) {
    const level = 8 + step * 10;
    const dr = rgb[0] - level;
    const dg = rgb[1] - level;
    const db = rgb[2] - level;
    const distance = dr * dr + dg * dg + db * db;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = 232 + step;
    }
  }

  return best;
};

const encodeColor = (rgb: Rgb, mode: MascotColorMode, layer: 38 | 48) =>
  mode === "truecolor"
    ? `${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}`
    : `${layer};5;${nearestXterm256(rgb)}`;

const sameColor = (first: Rgb | null, second: Rgb | null) =>
  first !== null &&
  second !== null &&
  first[0] === second[0] &&
  first[1] === second[1] &&
  first[2] === second[2];

const composeRows = (expression: MascotExpression): Array<string> => {
  const rows = [...baseRows];

  for (const [index, faceRow] of faceOverlays[expression].entries()) {
    const rowIndex = 3 + index;
    const baseRow = rows[rowIndex];

    if (baseRow === undefined) {
      continue;
    }

    const cells = baseRow.split("");

    for (let column = 0; column < faceRow.length; column++) {
      const code = faceRow[column];

      if (code !== undefined && code !== ".") {
        cells[6 + column] = code;
      }
    }

    rows[rowIndex] = cells.join("");
  }

  return rows;
};

export const pickMascotExpression = (random: () => number = Math.random): MascotExpression => {
  const index = Math.min(
    launchMascotExpressions.length - 1,
    Math.max(0, Math.floor(random() * launchMascotExpressions.length)),
  );

  return launchMascotExpressions[index] ?? "friendly";
};

export const renderMascot = (
  expression: MascotExpression = "friendly",
  colorMode: MascotColorMode = "truecolor",
): Array<string> => {
  const rows = composeRows(expression);
  const height = rows.length;
  const rendered: Array<string> = [];

  for (let row = 0; row < height; row += 2) {
    let line = "";
    let activeStyle = "";

    for (let column = 0; column < mascotWidth; column++) {
      const top = pixelColor(rows[row]?.[column] ?? ".", column, row, mascotWidth, height);

      const bottom = pixelColor(
        rows[row + 1]?.[column] ?? ".",
        column,
        row + 1,
        mascotWidth,
        height,
      );

      let style = "";
      let glyph = " ";

      if (top !== null && bottom !== null) {
        if (sameColor(top, bottom)) {
          style = encodeColor(top, colorMode, 38);
          glyph = "█";
        } else {
          style = `${encodeColor(top, colorMode, 38)};${encodeColor(bottom, colorMode, 48)}`;
          glyph = "▀";
        }
      } else if (top !== null) {
        style = encodeColor(top, colorMode, 38);
        glyph = "▀";
      } else if (bottom !== null) {
        style = encodeColor(bottom, colorMode, 38);
        glyph = "▄";
      }

      if (style !== activeStyle) {
        line += style === "" ? reset : `${activeStyle === "" ? "" : reset}${escape}${style}m`;
        activeStyle = style;
      }

      line += glyph;
    }

    if (activeStyle !== "") {
      line += reset;
    }

    rendered.push(line);
  }

  return rendered;
};
