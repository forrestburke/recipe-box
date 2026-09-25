// Merge the planned recipes' ingredients into one grocery list.
import { UNIT_FAMILIES, unitFamily } from './parser.js';
import { aisleFor, AISLE_ORDER } from './categorize.js';

const NICE_FRACTIONS = [[0, ''], [0.125, '⅛'], [0.25, '¼'], [0.333, '⅓'], [0.5, '½'], [0.667, '⅔'], [0.75, '¾'], [1, '']];

export function formatQty(n) {
  if (n == null || isNaN(n)) return '';
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n);
  const frac = n - whole;
  let best = NICE_FRACTIONS[0], diff = 1;
  for (const f of NICE_FRACTIONS) if (Math.abs(frac - f[0]) < diff) { best = f; diff = Math.abs(frac - f[0]); }
  if (diff > 0.06) return (Math.round(n * 100) / 100).toString();
  const w = best[0] === 1 ? whole + 1 : whole;
  return (w ? String(w) : '') + best[1] || '0';
}

const PLURAL_UNITS = new Set(['cup', 'clove', 'can', 'package', 'jar', 'bottle', 'slice', 'bunch', 'stick', 'head', 'sprig', 'stalk', 'handful', 'piece', 'fillet', 'quart', 'pint', 'gallon']);
export function unitLabel(unit, qty) {
  if (!unit) return '';
  if (PLURAL_UNITS.has(unit) && qty > 1) return unit === 'bunch' ? 'bunches' : unit === 'pinch' ? 'pinches' : unit + 's';
  return unit;
}

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Combine amounts that share a unit family (e.g. 1 tbsp + 1/2 cup)
function combineAmounts(entries) {
  const groups = new Map(); // groupKey -> { unit, qty, fam }
  let asNeeded = false;
  for (const e of entries) {
    if (e.qty == null) { asNeeded = true; continue; }
    const qty = e.qtyMax ?? e.qty;
    const fam = unitFamily(e.unit);
    const gk = fam || e.unit || 'count';
    const g = groups.get(gk);
    if (!g) groups.set(gk, { unit: e.unit, qty, fam, units: new Set([e.unit]) });
    else if (fam) {
      // convert into the larger of the two units
      const table = UNIT_FAMILIES[fam];
      const target = table[e.unit] > table[g.unit] ? e.unit : g.unit;
      g.qty = (g.qty * table[g.unit] + qty * table[e.unit]) / table[target];
      g.unit = target;
    } else g.qty += qty;
  }
  const parts = [...groups.values()].map(g => `${formatQty(g.qty)} ${unitLabel(g.unit, g.qty)}`.trim());
  if (asNeeded && !parts.length) parts.push('as needed');
  return parts.join(' + ');
}

export function isPantryItem(key, pantry) {
  return pantry.some(p => {
    const t = p.trim().toLowerCase();
    return t && (key === t || key.endsWith(' ' + t) || key === t + 's');
  });
}

// plan: { days: [{date, recipeId, skip}] }, state: { overrides: {key: bool}, custom: [{id, name, have}] }
export function buildShoppingList(plan, recipesById, pantry = [], state = {}) {
  const items = new Map();
  for (const day of plan?.days || []) {
    if (day.skip || !day.recipeId) continue;
    const r = recipesById.get(day.recipeId);
    if (!r) continue;
    for (const ing of r.ingredients || []) {
      if (!ing.key) continue;
      let it = items.get(ing.key);
      if (!it) items.set(ing.key, (it = { key: ing.key, name: titleCase(ing.display || ing.key), entries: [], recipes: new Set(), aisle: aisleFor(ing.key) }));
      it.entries.push(ing);
      it.recipes.add(r.title);
    }
  }

  const overrides = state.overrides || {};
  const list = [...items.values()].map(it => {
    const auto = isPantryItem(it.key, pantry);
    return {
      key: it.key,
      name: it.name,
      aisle: it.aisle,
      amount: combineAmounts(it.entries),
      recipes: [...it.recipes],
      raw: it.entries.map(e => e.raw),
      have: overrides[it.key] ?? auto,
      pantry: auto,
    };
  });
  for (const c of state.custom || []) {
    list.push({ key: 'custom:' + c.id, name: c.name, aisle: 'Added by you', amount: '', recipes: [], raw: [], have: !!c.have, custom: true, id: c.id });
  }
  const order = [...AISLE_ORDER, 'Added by you'];
  list.sort((a, b) => order.indexOf(a.aisle) - order.indexOf(b.aisle) || a.name.localeCompare(b.name));
  return list;
}

export function groupByAisle(list) {
  const groups = new Map();
  for (const it of list) {
    if (!groups.has(it.aisle)) groups.set(it.aisle, []);
    groups.get(it.aisle).push(it);
  }
  return groups;
}

export function listToText(list, title = 'Shopping list') {
  const need = list.filter(i => !i.have);
  let out = title + '\n';
  for (const [aisle, items] of groupByAisle(need)) {
    out += `\n${aisle.toUpperCase()}\n`;
    for (const i of items) out += `☐ ${i.name}${i.amount ? ' — ' + i.amount : ''}\n`;
  }
  return out;
}

export function listToCsv(list) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Aisle', 'Item', 'Amount', 'For recipes', 'Have it']];
  for (const i of list) rows.push([i.aisle, i.name, i.amount, i.recipes.join('; '), i.have ? 'yes' : 'no']);
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}
