// Parses free text (recipe ingredient lists, notes, documents, ...) into
// shopping list items: { name, quantity, unit, note, raw }.

const UNICODE_FRACTIONS = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125
};

// Canonical unit -> accepted spellings (lowercase). Swedish first, English as fallback.
const UNIT_ALIASES = {
  st: ['st', 'st.', 'styck', 'stycken', 'pcs', 'pc', 'piece', 'pieces'],
  g: ['g', 'gr', 'gram'],
  hg: ['hg', 'hekto'],
  kg: ['kg', 'kilo'],
  ml: ['ml'],
  cl: ['cl'],
  dl: ['dl'],
  l: ['l', 'liter', 'litre', 'litres', 'liters'],
  krm: ['krm'],
  tsk: ['tsk', 'tsp', 'teaspoon', 'teaspoons'],
  msk: ['msk', 'tbsp', 'tablespoon', 'tablespoons'],
  förp: ['förp', 'förp.', 'förpackning', 'förpackningar'],
  paket: ['paket', 'pkt', 'pkt.', 'pack'],
  burk: ['burk', 'burkar', 'can', 'cans', 'jar', 'jars'],
  flaska: ['flaska', 'flaskor', 'bottle', 'bottles'],
  påse: ['påse', 'påsar', 'bag', 'bags'],
  knippe: ['knippe', 'knippen', 'bunch', 'bunches'],
  klyfta: ['klyfta', 'klyftor', 'clove', 'cloves'],
  skiva: ['skiva', 'skivor', 'slice', 'slices'],
  kruka: ['kruka', 'krukor'],
  cup: ['cup', 'cups'],
  oz: ['oz'],
  lb: ['lb', 'lbs']
};

const UNIT_LOOKUP = new Map();
for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
  for (const alias of aliases) UNIT_LOOKUP.set(alias, canonical);
}

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');
const NUMBER_SOURCE = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[${FRACTION_CHARS}])?|[${FRACTION_CHARS}])`;
// "2", "1,5", "1 1/2", "1/2", "½", "1½" and ranges such as "2-3" or "2–3".
const LEADING_QUANTITY = new RegExp(`^(${NUMBER_SOURCE})(?:\\s*[-–]\\s*(${NUMBER_SOURCE}))?\\s*(?:x\\s+)?`, 'i');
const TRAILING_MULTIPLIER = /\s+(?:x\s*(\d+)|(\d+)\s*x)$/i;
const LEADING_MULTIPLIER = /^(\d+)\s*x\s+/i;
const BULLET = /^\s*(?:[-*•·▪◦‣–—+]|\[\s?[xX ]?\s?\]|[☐☑✓✔]|\d+[.)](?=\s))\s*/;

function parseNumber(text) {
  const value = text.trim();
  if (UNICODE_FRACTIONS[value] !== undefined) return UNICODE_FRACTIONS[value];

  const mixedUnicode = value.match(new RegExp(`^(\\d+)\\s*([${FRACTION_CHARS}])$`));
  if (mixedUnicode) return Number(mixedUnicode[1]) + UNICODE_FRACTIONS[mixedUnicode[2]];

  const mixed = value.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);

  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[2]) === 0 ? NaN : Number(fraction[1]) / Number(fraction[2]);

  return Number(value.replace(',', '.'));
}

function roundQuantity(value) {
  return Math.round(value * 100) / 100;
}

/** Returns the canonical unit for a token, or null if it is not a known unit. */
export function normalizeUnit(token) {
  if (!token) return null;
  return UNIT_LOOKUP.get(token.toLowerCase()) ?? null;
}

function isHeading(line) {
  // "Ingredienser:", "Till såsen:", "Dressing:" etc. are section headings, not items.
  return /:\s*$/.test(line);
}

/**
 * Parses a single line of text into an item, or returns null when the line
 * does not contain anything that looks like an item.
 */
export function parseLine(rawLine) {
  if (typeof rawLine !== 'string') return null;
  let line = rawLine.replace(/\s+/g, ' ').trim();
  line = line.replace(BULLET, '').trim();
  if (!line || isHeading(line)) return null;

  let quantity = null;
  let unit = null;
  let note = null;

  const leadingMultiplier = line.match(LEADING_MULTIPLIER);
  if (leadingMultiplier) {
    quantity = Number(leadingMultiplier[1]);
    line = line.slice(leadingMultiplier[0].length);
  } else {
    const leading = line.match(LEADING_QUANTITY);
    if (leading) {
      // For ranges ("2-3 tomater") we use the upper bound so the user has enough.
      const value = parseNumber(leading[2] ?? leading[1]);
      if (Number.isFinite(value) && value > 0) {
        quantity = roundQuantity(value);
        line = line.slice(leading[0].length);
        const unitMatch = line.match(/^([\p{L}]+\.?)(?=\s|$)/u);
        const canonical = unitMatch && normalizeUnit(unitMatch[1]);
        if (canonical && line.slice(unitMatch[0].length).trim()) {
          unit = canonical;
          line = line.slice(unitMatch[0].length);
        }
      }
    }
  }

  if (quantity === null) {
    const trailing = line.match(TRAILING_MULTIPLIER);
    if (trailing) {
      quantity = Number(trailing[1] ?? trailing[2]);
      line = line.slice(0, trailing.index);
    }
  }

  const parenthesis = line.match(/\s*\(([^)]*)\)\s*/);
  if (parenthesis) {
    note = parenthesis[1].trim() || null;
    line = (line.slice(0, parenthesis.index) + ' ' + line.slice(parenthesis.index + parenthesis[0].length)).trim();
  }

  const name = line.replace(/^(?:of|av)\s+/i, '').replace(/[\s,.;:]+$/, '').trim();
  if (!name || !/\p{L}/u.test(name)) return null;

  return { name, quantity, unit, note, raw: rawLine.trim() };
}

/**
 * Parses a block of selected text into a list of items. Items are separated
 * by line breaks or semicolons. Comma-separated single lines ("mjölk, ägg, smör")
 * are split as well when no line breaks are present.
 */
export function parseItems(text) {
  if (typeof text !== 'string') return [];
  let lines = text.split(/\r?\n|;/);
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length === 1 && nonEmpty[0].includes(',') && !/\d,\d/.test(nonEmpty[0])) {
    lines = nonEmpty[0].split(',');
  }
  return lines.map(parseLine).filter(Boolean);
}
