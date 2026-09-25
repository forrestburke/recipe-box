// Meal plan generation: random dinners for a date range, honouring filters.

export function dateRange(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  if (isNaN(d) || isNaN(last) || d > last) return out;
  while (d <= last && out.length < 92) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function formatDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function splitTerms(s) {
  return String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

// filters: { mealTypes: [], excludeProteins: [], excludeTags: [], requireTags: [], excludeIngredients: 'mushroom, cilantro' }
export function matchesFilters(recipe, filters) {
  const f = filters || {};
  if (f.mealTypes?.length && !recipe.mealTypes?.some(m => f.mealTypes.includes(m))) return false;
  if (f.excludeProteins?.length && recipe.proteins?.some(p => f.excludeProteins.includes(p))) return false;
  if (f.excludeTags?.length && recipe.tags?.some(t => f.excludeTags.includes(t))) return false;
  if (f.requireTags?.length && !f.requireTags.every(t => recipe.tags?.includes(t))) return false;
  const bad = splitTerms(f.excludeIngredients);
  if (bad.length) {
    const text = (recipe.ingredients || []).map(i => i.raw || i).join(' ').toLowerCase() + ' ' + (recipe.title || '').toLowerCase();
    if (bad.some(term => text.includes(term))) return false;
  }
  return true;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// existingDays: previous plan days, locked ones are kept. Returns { days, warnings }.
export function generatePlan(recipes, filters, dates, existingDays = [], opts = {}) {
  const pool = recipes.filter(r => matchesFilters(r, filters));
  const warnings = [];
  const prev = new Map(existingDays.map(d => [d.date, d]));
  const days = dates.map(date => {
    const p = prev.get(date);
    return p && (p.locked || p.skip) ? { ...p } : { date, recipeId: null, locked: false, skip: false };
  });

  if (!pool.length) {
    warnings.push('No recipes match these filters. Loosen the filters or add more recipes.');
    return { days, warnings };
  }

  const used = new Set(days.filter(d => d.recipeId).map(d => d.recipeId));
  let queue = shuffle(pool.filter(r => !used.has(r.id)));
  let repeated = false;
  const byId = new Map(recipes.map(r => [r.id, r]));

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (day.locked || day.skip) continue;
    if (!queue.length) { queue = shuffle(pool); repeated = true; }
    const prevProteins = byId.get(days[i - 1]?.recipeId)?.proteins || [];
    let idx = 0;
    if (opts.avoidBackToBack && prevProteins.length) {
      const alt = queue.findIndex(r => !r.proteins?.some(p => prevProteins.includes(p)));
      if (alt !== -1) idx = alt;
    }
    day.recipeId = queue.splice(idx, 1)[0].id;
  }
  if (repeated) warnings.push(`Only ${pool.length} recipe${pool.length === 1 ? '' : 's'} match your filters, so some meals repeat.`);
  return { days, warnings };
}

export function pickOne(recipes, filters, excludeIds = []) {
  const pool = recipes.filter(r => matchesFilters(r, filters));
  const fresh = pool.filter(r => !excludeIds.includes(r.id));
  const from = fresh.length ? fresh : pool;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}
