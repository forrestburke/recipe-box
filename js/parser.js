// Recipe parsing without AI:
//  1. Web pages  -> schema.org "Recipe" JSON-LD / microdata (used by almost every recipe site)
//  2. Plain text -> heuristics (section headers, quantity/unit detection) for OCR'd scans, PDFs and pasted text
//  3. Ingredient lines -> { qty, unit, name, key } so shopping lists can be merged

const UNICODE_FRACTIONS = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5',
  '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

export function normalizeFractions(s) {
  return s
    .replace(/⁄/g, '/')
    .replace(/(\d)?\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (m, d, f) => (d ? d + ' ' : '') + UNICODE_FRACTIONS[f]);
}

function parseNumber(tok) {
  tok = tok.trim();
  let m;
  if ((m = tok.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
  if ((m = tok.match(/^(\d+)\/(\d+)$/))) return m[1] / m[2];
  const n = parseFloat(tok.replace(',', '.'));
  return isNaN(n) ? null : n;
}

const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, half: 0.5, dozen: 12 };

// canonical unit -> spellings (longest first matters for matching)
const UNIT_TABLE = [
  ['tbsp', ['tablespoons', 'tablespoon', 'tbsps', 'tbsp', 'tbs', 'tbl', 'tb']],
  ['tsp', ['teaspoons', 'teaspoon', 'tsps', 'tsp']],
  ['fl oz', ['fluid ounces', 'fluid ounce', 'fl. oz', 'fl oz']],
  ['cup', ['cups', 'cup', 'c']],
  ['oz', ['ounces', 'ounce', 'oz']],
  ['lb', ['pounds', 'pound', 'lbs', 'lb']],
  ['kg', ['kilograms', 'kilogram', 'kgs', 'kg']],
  ['g', ['grams', 'gram', 'gr', 'g']],
  ['ml', ['milliliters', 'millilitres', 'milliliter', 'millilitre', 'ml']],
  ['l', ['liters', 'litres', 'liter', 'litre', 'l']],
  ['quart', ['quarts', 'quart', 'qt']],
  ['pint', ['pints', 'pint', 'pt']],
  ['gallon', ['gallons', 'gallon', 'gal']],
  ['clove', ['cloves', 'clove']],
  ['can', ['cans', 'can', 'tins', 'tin']],
  ['package', ['packages', 'package', 'pkgs', 'pkg', 'packets', 'packet']],
  ['jar', ['jars', 'jar']],
  ['bottle', ['bottles', 'bottle']],
  ['pinch', ['pinches', 'pinch']],
  ['dash', ['dashes', 'dash']],
  ['slice', ['slices', 'slice']],
  ['bunch', ['bunches', 'bunch']],
  ['stick', ['sticks', 'stick']],
  ['head', ['heads', 'head']],
  ['sprig', ['sprigs', 'sprig']],
  ['stalk', ['stalks', 'stalk']],
  ['handful', ['handfuls', 'handful']],
  ['piece', ['pieces', 'piece']],
  ['fillet', ['fillets', 'fillet']],
];
const UNIT_LOOKUP = new Map();
for (const [canon, spellings] of UNIT_TABLE) for (const s of spellings) UNIT_LOOKUP.set(s, canon);
const UNIT_REGEX = new RegExp(
  '^(' + [...UNIT_LOOKUP.keys()].sort((a, b) => b.length - a.length).map(s => s.replace(/[.]/g, '\\.')).join('|') + ')\\.?(?=\\s|$)',
  'i'
);

export const UNIT_NAMES = UNIT_TABLE.map(([canon]) => canon);

// "Tablespoons" -> "tbsp"; unknown units (e.g. "bag") are kept as typed
export function normalizeUnit(text) {
  const t = String(text || '').trim().replace(/\.$/, '');
  if (!t) return null;
  if (t === 'T') return 'tbsp';
  if (t === 't') return 'tsp';
  return UNIT_LOOKUP.get(t.toLowerCase()) || t.toLowerCase();
}

// "1 1/2", "1½", "2-3", "0.5" -> { qty, qtyMax }; blank or unreadable -> nulls
export function parseQuantity(text) {
  const s = normalizeFractions(String(text || '').trim());
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s*(?:-|–|to)\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?))?$/);
  if (!m) return { qty: null, qtyMax: null };
  return { qty: parseNumber(m[1]), qtyMax: m[2] ? parseNumber(m[2]) : null };
}

export const UNIT_FAMILIES = {
  volume: { tsp: 1, tbsp: 3, 'fl oz': 6, cup: 48, pint: 96, quart: 192, gallon: 768, ml: 0.2029, l: 202.9 },
  weight: { g: 1, kg: 1000, oz: 28.35, lb: 453.6 },
};
export function unitFamily(unit) {
  for (const [fam, table] of Object.entries(UNIT_FAMILIES)) if (unit in table) return fam;
  return null;
}

const PREP_WORDS = [
  'freshly', 'fresh', 'finely', 'coarsely', 'roughly', 'thinly', 'thickly', 'lightly', 'well', 'very',
  'chopped', 'diced', 'minced', 'sliced', 'grated', 'shredded', 'crushed', 'peeled', 'seeded', 'deseeded',
  'cubed', 'halved', 'quartered', 'trimmed', 'rinsed', 'drained', 'softened', 'melted', 'beaten', 'julienned',
  'cooked', 'uncooked', 'large', 'medium', 'small', 'extra-large', 'jumbo', 'boneless', 'skinless', 'packed',
  'heaping', 'scant', 'level', 'about', 'approximately', 'roughly', 'ripe', 'cold', 'warm', 'hot', 'room-temperature',
];
const PREP_REGEX = new RegExp('\\b(' + PREP_WORDS.join('|') + ')\\b', 'gi');

const SINGULAR_EXCEPTIONS = new Set([
  'hummus', 'asparagus', 'couscous', 'molasses', 'swiss', 'bass', 'watercress', 'lemongrass', 'brussels',
  'citrus', 'octopus', 'grits', 'oats', 'greens', 'series', 'hibiscus', 'haricots', 'lentils', 'peas', 'jus',
]);
const IRREGULAR = { leaves: 'leaf', loaves: 'loaf', halves: 'half', knives: 'knife', potatoes: 'potato', tomatoes: 'tomato' };

function singularize(word) {
  if (SINGULAR_EXCEPTIONS.has(word)) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/(ch|sh|ss|x)es$/.test(word)) return word.slice(0, -2);
  if (/[^su]s$/.test(word)) return word.slice(0, -1);
  return word;
}

const ALIASES = {
  'parmesan cheese': 'parmesan', 'parmigiano reggiano': 'parmesan', 'parmigiano-reggiano': 'parmesan', 'grated parmesan': 'parmesan',
  'scallion': 'green onion', 'spring onion': 'green onion', 'garbanzo bean': 'chickpea', 'coriander leaf': 'cilantro',
  'bread crumb': 'breadcrumb', 'panko breadcrumb': 'panko', 'panko bread crumb': 'panko', 'kosher salt': 'salt', 'sea salt': 'salt', 'table salt': 'salt',
  'ground black pepper': 'black pepper', 'cracked black pepper': 'black pepper', 'unsalted butter': 'butter', 'salted butter': 'butter',
  'granulated sugar': 'sugar', 'white sugar': 'sugar', 'plain flour': 'all-purpose flour', 'flour': 'all-purpose flour',
  'light brown sugar': 'brown sugar', 'dark brown sugar': 'brown sugar', 'large egg': 'egg', 'clove garlic': 'garlic', 'garlic clove': 'garlic',
};

// opts.keepPrep keeps words like "crushed"/"diced" (canned goods), opts.plural skips singularising (for display)
export function normalizeName(name, opts = {}) {
  let n = ' ' + name.toLowerCase() + ' ';
  n = n.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  n = n.split(/,|;|\bfor (serving|garnish|the)\b/)[0];
  n = n.replace(/\b(to taste|optional|as needed|if needed|divided|plus more.*|or more.*|or to taste.*|at room temperature)\b/g, ' ');
  n = n.replace(/\bextra[- ]virgin\b/g, ' ');
  if (opts.keepPrep) n = n.replace(/\b(large|medium|small|about|approximately|heaping|scant)\b/g, ' ');
  else n = n.replace(PREP_REGEX, ' ');
  n = n.replace(/^[\s\-–—]*(of|a|an|the)\s+/, ' ');
  n = n.replace(/[^a-zà-ÿ'\-\s&]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^(and|or|of)\s+|\s+(and|or|of)$/g, '').trim();
  if (opts.plural) return n;
  const words = n.split(' ');
  if (words.length) words[words.length - 1] = singularize(words[words.length - 1]);
  n = words.join(' ').trim();
  return opts.noAlias ? n : ALIASES[n] || n;
}

// "1 1/2 cups (200g) all-purpose flour, sifted" -> { qty: 1.5, unit: 'cup', name: 'all-purpose flour, sifted', key: 'all-purpose flour' }
export function parseIngredientLine(raw) {
  const original = raw.trim();
  let s = normalizeFractions(original).replace(/^[\-•*▢□▪◦●○·✓✔]\s*/, '').trim();
  let qty = null, qtyMax = null, unit = null, note = '';

  const qtyMatch = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s*(?:-|–|to)\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?))?\s*/);
  if (qtyMatch) {
    qty = parseNumber(qtyMatch[1]);
    if (qtyMatch[2]) qtyMax = parseNumber(qtyMatch[2]);
    s = s.slice(qtyMatch[0].length);
  } else {
    const w = s.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half|dozen)\s+/i);
    if (w && (UNIT_REGEX.test(s.slice(w[0].length)) || /^(a|an|one|two|three|four|five|six|half|dozen)$/i.test(w[1]))) {
      qty = WORD_NUMBERS[w[1].toLowerCase()];
      s = s.slice(w[0].length);
    }
  }

  // "(14 oz)" size notes right after the quantity
  const paren = s.match(/^\(([^)]*)\)\s*/);
  if (paren) { note = paren[1]; s = s.slice(paren[0].length); }

  // Single-letter T / t (tablespoon / teaspoon) are case-sensitive
  const caseUnit = s.match(/^(T|t)\.?\s+/);
  if (caseUnit && qty != null) {
    unit = caseUnit[1] === 'T' ? 'tbsp' : 'tsp';
    s = s.slice(caseUnit[0].length);
  } else {
    const u = s.match(UNIT_REGEX);
    if (u && qty != null) {
      unit = UNIT_LOOKUP.get(u[1].toLowerCase());
      s = s.slice(u[0].length).replace(/^\.?\s*(of\s+)?/i, '');
    }
  }

  let name = s.trim();
  const canned = ['can', 'jar', 'package', 'bottle'].includes(unit);
  let key = normalizeName(name, { keepPrep: canned, noAlias: true });
  let display = normalizeName(name, { keepPrep: canned, plural: true });

  // "3 garlic cloves" -> unit clove, key garlic
  if (!unit && qty != null) {
    const tail = key.match(/\s(clove|stalk|sprig|head|bunch|fillet)$/);
    if (tail) { unit = tail[1]; key = key.slice(0, -tail[0].length).trim(); display = key; }
  }
  // bare "pepper" in small amounts is black pepper
  if (key === 'pepper' && (qty == null || ['tsp', 'tbsp', 'pinch', 'dash'].includes(unit))) key = display = 'black pepper';
  if (ALIASES[key]) key = display = ALIASES[key];

  return { raw: original, qty, qtyMax, unit, name, key, display, note };
}

// Split combined lines like "salt and pepper to taste" into separate items
export function parseIngredients(lines) {
  const out = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (/^\s*(salt\s*(and|&)\s*(black\s+)?pepper)/i.test(line) || /^\s*(kosher\s+)?salt\s*(and|&)\s*(freshly\s+)?(ground\s+)?(black\s+)?pepper/i.test(line)) {
      out.push({ raw: line, qty: null, unit: null, name: 'salt', key: 'salt', display: 'salt', note: '' });
      out.push({ raw: line, qty: null, unit: null, name: 'black pepper', key: 'black pepper', display: 'black pepper', note: '' });
      continue;
    }
    const p = parseIngredientLine(line);
    if (p.key) out.push(p);
  }
  return out;
}

// ---------- Web pages ----------

function decodeHtml(s) {
  if (s == null) return '';
  const doc = new DOMParser().parseFromString(String(s), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function findRecipeNode(d, depth = 0) {
  if (!d || typeof d !== 'object' || depth > 6) return null;
  if (Array.isArray(d)) {
    for (const x of d) { const r = findRecipeNode(x, depth + 1); if (r) return r; }
    return null;
  }
  const types = [].concat(d['@type'] || []);
  if (types.some(t => String(t).toLowerCase() === 'recipe')) return d;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (d[k]) { const r = findRecipeNode(d[k], depth + 1); if (r) return r; }
  }
  return null;
}

function flattenInstructions(ins) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') {
      const txt = x.includes('<') ? htmlToText(new DOMParser().parseFromString(x, 'text/html')) : x;
      txt.split(/\n+/).map(t => decodeHtml(t)).filter(Boolean).forEach(t => out.push(t));
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') {
      if (x.itemListElement) walk(x.itemListElement);
      else if (x.text) out.push(decodeHtml(x.text));
      else if (x.name) out.push(decodeHtml(x.name));
    }
  };
  walk(ins);
  return out.map(t => t.replace(/^(step\s*)?\d+[.):]\s*/i, '').trim()).filter(Boolean);
}

export function isoDurationToMinutes(d) {
  if (!d || typeof d !== 'string') return null;
  const m = d.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return mins || null;
}

function firstNumber(v) {
  const s = Array.isArray(v) ? v.join(' ') : String(v ?? '');
  const m = s.match(/\d+/);
  return m ? +m[0] : null;
}

function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(asList);
  return String(v).split(',').map(s => decodeHtml(s)).filter(Boolean);
}

function imageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return imageUrl(img[0]);
  return img.url || img.contentUrl || '';
}

function fromJsonLd(r, url) {
  return {
    title: decodeHtml(r.name) || 'Untitled recipe',
    sourceUrl: url || '',
    image: imageUrl(r.image),
    servings: firstNumber(r.recipeYield),
    totalTime: isoDurationToMinutes(r.totalTime) || ((isoDurationToMinutes(r.prepTime) || 0) + (isoDurationToMinutes(r.cookTime) || 0)) || null,
    ingredients: [].concat(r.recipeIngredient || r.ingredients || []).map(decodeHtml).filter(Boolean),
    steps: flattenInstructions(r.recipeInstructions),
    hints: [...asList(r.recipeCategory), ...asList(r.recipeCuisine), ...asList(r.keywords)].map(s => s.toLowerCase()),
    method: 'structured',
  };
}

export function htmlToText(doc) {
  const root = (doc.querySelector('article') || doc.querySelector('main') || doc.body || doc.documentElement).cloneNode(true);
  root.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe,svg,button').forEach(el => el.remove());
  root.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  root.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,section,article,ul,ol').forEach(el => el.append('\n'));
  return (root.textContent || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function extractRecipeFromHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data = null;
    try { data = JSON.parse(s.textContent); }
    catch { try { data = JSON.parse(s.textContent.replace(/[\u0000-\u001F]+/g, ' ')); } catch { continue; } }
    const node = findRecipeNode(data);
    if (node) {
      const r = fromJsonLd(node, url);
      if (r.ingredients.length) return r;
    }
  }

  // Microdata fallback (older sites)
  const md = doc.querySelector('[itemtype*="schema.org/Recipe" i]');
  if (md) {
    const text = (sel) => [...md.querySelectorAll(sel)].map(el => (el.getAttribute('content') || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const ingredients = text('[itemprop="recipeIngredient"],[itemprop="ingredients"]');
    if (ingredients.length) {
      return {
        title: text('[itemprop="name"]')[0] || doc.title || 'Untitled recipe',
        sourceUrl: url || '',
        image: md.querySelector('[itemprop="image"]')?.getAttribute('src') || md.querySelector('[itemprop="image"]')?.getAttribute('content') || '',
        servings: firstNumber(text('[itemprop="recipeYield"]')[0]),
        totalTime: isoDurationToMinutes(md.querySelector('[itemprop="totalTime"]')?.getAttribute('content')),
        ingredients,
        steps: text('[itemprop="recipeInstructions"]').flatMap(t => t.split(/\n+/)),
        hints: text('[itemprop="recipeCategory"],[itemprop="recipeCuisine"]').map(s => s.toLowerCase()),
        method: 'structured',
      };
    }
  }

  // Last resort: page text + heuristics
  const parsed = parseRecipeText(htmlToText(doc));
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  return { ...parsed, title: ogTitle || doc.title || parsed.title, sourceUrl: url || '', method: 'heuristic' };
}

// ---------- Plain text (OCR, PDF, paste) ----------

// Fix common OCR misreads in quantities and units
export function cleanOcrText(text) {
  return text
    .replace(/(\d)[oO](?=\d|\b)/g, '$10')                       // 9o -> 90
    .replace(/\b[oO](?=\d)/g, '0')
    .replace(/^([lI|])(?=\s+(cups?|tbsp|tsp|tablespoons?|teaspoons?|lbs?|oz|pounds?|ounces?|cans?|large|medium|small)\b)/gim, '1') // "l cup" -> "1 cup"
    .replace(/(\d\s*)(1bs?|Ibs?|\|bs?)\b/g, '$1lbs')
    .replace(/\b(thsp|tbps|tblsp|tbsps|tbsn|tbs\.)\b/gi, 'tbsp')
    .replace(/\b(tsps|tspn|tso)\b/gi, 'tsp')
    .replace(/\b(\d)\s*\/\s*(\d)\b/g, '$1/$2')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/^[©®°•]\s*/gm, '');
}

const INGR_HEAD = /^\s*(ingredients?|what you('|’)?ll need|you will need|you'll need)\s*:?\s*$/i;
const STEP_HEAD = /^\s*(directions?|instructions?|method|steps?|preparation|how to make( it)?|procedure|to make)\s*:?\s*$/i;
const NOTE_HEAD = /^\s*(notes?|tips?|cook'?s notes?|nutrition( facts| information| info)?|variations?|storage)\s*:?\s*$/i;
const BULLET = /^[\-•*▢□▪◦●○·✓✔]\s*/;
const STARTS_WITH_QTY = /^([\-•*▢□▪◦●○·]\s*)?(\d+\s*\/\s*\d+|\d+([.,]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])(\s|[a-z]|$)/i;
const UNIT_NEAR_START = /^\S+\s+(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|cloves?|cans?|pinch|dash)\b/i;
const STEP_NUMBER = /^(step\s*)?\d{1,2}\s*[.):]\s+/i;

function looksLikeIngredient(line) {
  if (line.length > 90) return false;
  if (STEP_NUMBER.test(line) && line.length > 45) return false;
  return STARTS_WITH_QTY.test(line) || UNIT_NEAR_START.test(line) || /^(salt|pepper|kosher salt|black pepper|olive oil)\b/i.test(line);
}

function mergeWrappedSteps(lines) {
  const out = [];
  for (let line of lines) {
    const isNew = STEP_NUMBER.test(line) || BULLET.test(line);
    line = line.replace(STEP_NUMBER, '').replace(BULLET, '').trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev && !isNew && (!/[.!?)]$/.test(prev) || /^[a-z]/.test(line))) out[out.length - 1] = prev + ' ' + line;
    else out.push(line);
  }
  return out;
}

function mergeWrappedIngredients(lines) {
  const out = [];
  for (let line of lines) {
    line = line.replace(BULLET, '').trim();
    if (!line || /:$/.test(line)) continue; // sub-headers like "For the sauce:"
    const prev = out[out.length - 1];
    if (prev && (/^[a-z(]/.test(line) && !looksLikeIngredient(line)) && (/[,(-]$/.test(prev) || /^\(/.test(line) || /^(or|and|plus|about)\b/.test(line))) {
      out[out.length - 1] = prev + ' ' + line;
    } else out.push(line);
  }
  return out;
}

export function parseRecipeText(text) {
  const lines = normalizeFractions(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l && !/^[\W_]+$/.test(l));

  let servings = null, totalTime = null;
  const whole = lines.join('\n');
  const sm = whole.match(/\b(serves|servings|yield|yields|makes)\s*:?\s*(\d+)/i);
  if (sm) servings = +sm[2];
  const tm = whole.match(/\btotal( time)?\s*:?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (tm && (tm[2] || tm[3])) totalTime = (+tm[2] || 0) * 60 + (+tm[3] || 0);

  const ingIdx = lines.findIndex(l => INGR_HEAD.test(l));
  const stepIdx = lines.findIndex(l => STEP_HEAD.test(l));
  const isMeta = l => /^(serves|servings|yields?|makes)\b\s*:?\s*\d|^(prep|cook|total|active|cooking|baking)(\s+time)?\s*:|^(prep|cook|total|active)\s+time\b/i.test(l);

  const titleCandidates = lines.slice(0, Math.max(1, Math.min(ingIdx === -1 ? 5 : ingIdx, 5)));
  const title = titleCandidates.find(l => l.length >= 3 && l.length <= 80 && /[a-z]/i.test(l) && !INGR_HEAD.test(l) && !STEP_HEAD.test(l) && !isMeta(l) && !looksLikeIngredient(l)) || 'Untitled recipe';

  let ingredients = [], steps = [], notes = [];

  if (ingIdx !== -1 || stepIdx !== -1) {
    let section = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (INGR_HEAD.test(l)) { section = 'ing'; continue; }
      if (STEP_HEAD.test(l)) { section = 'step'; continue; }
      if (NOTE_HEAD.test(l)) { section = 'note'; continue; }
      if (l === title && section === null) continue;
      if (section === 'ing') ingredients.push(l);
      else if (section === 'step') steps.push(l);
      else if (section === 'note') notes.push(l);
      else if (looksLikeIngredient(l)) ingredients.push(l); // content before any header
    }
    // header for one section but not the other: split by shape
    if (ingIdx === -1 && ingredients.length === 0) {
      ingredients = steps.filter(looksLikeIngredient);
      steps = steps.filter(l => !looksLikeIngredient(l));
    }
    if (stepIdx === -1) {
      const after = ingredients;
      ingredients = after.filter((l, i) => looksLikeIngredient(l) || (i > 0 && l.length < 45 && !/[.!?]$/.test(l)));
      steps = steps.concat(after.filter(l => !ingredients.includes(l)));
    }
  } else {
    for (const l of lines) {
      if (l === title || isMeta(l)) continue;
      if (looksLikeIngredient(l)) ingredients.push(l);
      else if (l.length > 25) steps.push(l);
    }
  }

  return {
    title,
    servings,
    totalTime,
    ingredients: mergeWrappedIngredients(ingredients.filter(l => !isMeta(l))),
    steps: mergeWrappedSteps(steps.filter(l => !isMeta(l))),
    notes: notes.join('\n'),
    hints: [],
    method: 'heuristic',
  };
}
