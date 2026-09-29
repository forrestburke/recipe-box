// Spreadsheet (CSV) import. One row per recipe; multi-line cells hold ingredients and steps.

// RFC 4180-style parser: quoted cells, "" escapes, line breaks inside quotes.
// Detects comma, semicolon (European Excel) or tab separators.
export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const COLUMNS = {
  title: ['title', 'name', 'recipe', 'recipe name'],
  servings: ['servings', 'serves', 'yield', 'portions'],
  totalTime: ['total time', 'total_time', 'total_time_minutes', 'time', 'minutes', 'total time (min)'],
  mealTypes: ['meal type', 'meal types', 'meal_types', 'meal_type', 'meal', 'category', 'course'],
  proteins: ['protein', 'main protein', 'main_protein', 'proteins'],
  tags: ['tags', 'keywords', 'labels'],
  ingredients: ['ingredients', 'ingredient list'],
  steps: ['steps', 'instructions', 'directions', 'method', 'preparation'],
  notes: ['notes', 'note', 'comments'],
  sourceUrl: ['source url', 'source_url', 'url', 'link', 'source'],
  image: ['image url', 'image_url', 'image', 'photo', 'picture'],
};

// "90", "1 hr 30 min", "1h30", "45 minutes" -> minutes
function parseMinutes(v) {
  const s = String(v || '').toLowerCase();
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours)\b/);
  const m = s.match(/(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (h || m) return Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? +m[1] : 0)) || null;
  return parseInt(s, 10) || null;
}

const list = (v) => String(v || '').split(/\s*[,;]\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
// One per line; a single line can also use " | " as the separator
const lines = (v) => {
  const s = String(v || '').trim();
  if (!s) return [];
  const parts = s.includes('\n') ? s.split(/\r?\n/) : s.split(/\s*\|\s*/);
  return parts.map(x => x.replace(/^\s*(\d+[.)]|[-•*])\s+/, '').trim()).filter(Boolean);
};

// Returns { drafts, skipped, unknownColumns }
export function recipesFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file needs a header row and at least one recipe row.');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const index = {};
  const unknownColumns = [];
  header.forEach((h, i) => {
    const field = Object.keys(COLUMNS).find(f => COLUMNS[f].includes(h));
    if (field && index[field] === undefined) index[field] = i; else if (h) unknownColumns.push(rows[0][i]);
  });
  if (index.title === undefined) throw new Error('Could not find a "title" column. Download the template to see the expected columns.');
  if (index.ingredients === undefined) throw new Error('Could not find an "ingredients" column. Download the template to see the expected columns.');

  const get = (row, f) => index[f] === undefined ? '' : (row[index[f]] ?? '');
  const drafts = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const title = get(row, 'title').trim();
    if (!title) { skipped++; continue; }
    const d = {
      title,
      servings: parseInt(get(row, 'servings'), 10) || null,
      totalTime: parseMinutes(get(row, 'totalTime')),
      ingredients: lines(get(row, 'ingredients')),
      steps: lines(get(row, 'steps')),
      notes: get(row, 'notes').trim(),
      sourceUrl: get(row, 'sourceUrl').trim(),
      image: get(row, 'image').trim(),
      source: { type: 'csv' },
      method: 'structured',
      hints: [],
    };
    // Columns left blank are filled in by the automatic categorisation
    const meals = list(get(row, 'mealTypes')), proteins = list(get(row, 'proteins')), tags = list(get(row, 'tags'));
    if (meals.length) d.mealTypes = meals.map(m => m === 'baked goods' || m === 'baking' ? 'baked good' : m);
    if (proteins.length) d.proteins = proteins;
    if (tags.length) d.tags = tags;
    drafts.push(d);
  }
  return { drafts, skipped, unknownColumns };
}

export function csvTemplate() {
  const esc = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = [
    ['title', 'servings', 'total_time_minutes', 'meal_type', 'main_protein', 'tags', 'ingredients', 'steps', 'notes', 'source_url', 'image_url'],
    ['Grandma\'s Meatloaf', '6', '75', 'dinner', 'beef', 'family favourite',
      '2 lb ground beef\n1 cup breadcrumbs\n2 eggs\n1 onion, diced\n1/2 cup ketchup',
      'Heat oven to 350°F.\nMix everything except the ketchup and shape into a loaf.\nTop with ketchup and bake 1 hour.',
      'Leftovers make great sandwiches.', '', ''],
    ['Overnight Oats', '2', '5', 'breakfast', '', 'quick, vegetarian',
      '1 cup rolled oats | 1 cup milk | 1/2 cup yogurt | 1 tbsp honey | 1/2 cup berries',
      'Stir everything together | Refrigerate overnight | Top with berries',
      'Leave meal_type, main_protein or tags blank and they are filled in automatically.', '', ''],
  ];
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}
