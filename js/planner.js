// Meal plan generation: random meals (breakfast / lunch / dinner) for a date range, honouring filters.
//
// Plan shape:
//   { start, end, meals: ['dinner'], people: 4,
//     days: [{ date, slots: { dinner: { recipeId, locked, skip, servings } } }] }

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'];

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

// Older plans stored one dinner per day as { date, recipeId, locked, skip }
export function normalizePlan(plan) {
  if (!plan) return plan;
  const days = (plan.days || []).map(d => {
    if (d.slots) return d;
    const { date, recipeId, locked, skip } = d;
    return { date, slots: recipeId || skip ? { dinner: { recipeId: recipeId || null, locked: !!locked, skip: !!skip } } : {} };
  });
  return { meals: ['dinner'], ...plan, days };
}

function splitTerms(s) {
  return String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

// filters: { mealTypes, excludeProteins, excludeTags, requireTags, excludeIngredients: 'mushroom, cilantro', kitchens: [ids] }
export function matchesFilters(recipe, filters) {
  const f = filters || {};
  const types = recipe.mealTypes?.length ? recipe.mealTypes : ['dinner'];
  if (f.mealTypes?.length && !types.some(m => f.mealTypes.includes(m))) return false;
  if (f.kitchens?.length && !f.kitchens.includes(recipe.kitchen || 'local')) return false;
  if (f.excludeProteins?.length && recipe.proteins?.some(p => f.excludeProteins.includes(p))) return false;
  if (f.excludeTags?.length && recipe.tags?.some(t => f.excludeTags.includes(t))) return false;
  if (f.requireTags?.length && !f.requireTags.every(t => recipe.tags?.includes(t))) return false;
  const bad = splitTerms(f.excludeIngredients);
  if (bad.length) {
    const text = (recipe.ingredients || []).map(i => (i && (i.raw || i.key)) || String(i || '')).join(' ').toLowerCase() + ' ' + (recipe.title || '').toLowerCase();
    if (bad.some(term => termRegex(term).test(text))) return false;
  }
  return true;
}

function termRegex(term) {
  const stem = term.replace(/(ies)$/, 'y').replace(/(oes|ches|shes|sses|xes)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1');
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc + '(e?s|ies)?\\b', 'i');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fills every unlocked, un-skipped slot for the chosen meals. Returns { days, warnings }.
// opts: { meals: ['dinner'], avoidBackToBack, servings }
export function generatePlan(recipes, filters, dates, existingDays = [], opts = {}) {
  const meals = opts.meals?.length ? opts.meals : ['dinner'];
  const warnings = [];
  const prev = new Map(existingDays.map(d => [d.date, d]));
  const days = dates.map(date => {
    const slots = {};
    for (const [meal, s] of Object.entries(prev.get(date)?.slots || {})) {
      // keep locked/skipped slots, and slots for meals we're not re-planning
      if (s.locked || s.skip || !meals.includes(meal)) slots[meal] = { ...s };
    }
    return { date, slots };
  });
  const byId = new Map(recipes.map(r => [r.id, r]));
  const used = new Set(days.flatMap(d => Object.values(d.slots).map(s => s.recipeId)).filter(Boolean));

  for (const meal of meals) {
    const pool = recipes.filter(r => matchesFilters(r, { ...filters, mealTypes: [meal] }));
    if (!pool.length) {
      warnings.push(`No ${meal} recipes match these filters${meal !== 'dinner' ? ` — tag some recipes as "${meal}"` : ''}.`);
      continue;
    }
    let queue = shuffle(pool.filter(r => !used.has(r.id)));
    let repeated = false;
    for (let i = 0; i < days.length; i++) {
      const cur = days[i].slots[meal];
      if (cur?.locked || cur?.skip) continue;
      const yesterday = days[i - 1]?.slots[meal]?.recipeId;
      if (!queue.length) {
        queue = shuffle(pool);
        repeated = true;
        if (queue.length > 1 && queue[0].id === yesterday) queue.push(queue.shift());
      }
      const prevProteins = byId.get(days[i - 1]?.slots[meal]?.recipeId)?.proteins || [];
      let idx = 0;
      if (opts.avoidBackToBack && meal !== 'breakfast' && prevProteins.length) {
        const alt = queue.findIndex(r => !r.proteins?.some(p => prevProteins.includes(p)));
        if (alt !== -1) idx = alt;
      }
      const pick = queue.splice(idx, 1)[0];
      used.add(pick.id);
      const oldServings = prev.get(days[i].date)?.slots?.[meal]?.servings;
      days[i].slots[meal] = { recipeId: pick.id, locked: false, skip: false, servings: cur?.servings ?? oldServings ?? opts.servings ?? null };
    }
    if (repeated) warnings.push(`Only ${pool.length} ${meal} recipe${pool.length === 1 ? '' : 's'} match your filters, so some repeat.`);
  }
  return { days, warnings };
}

export function pickOne(recipes, filters, excludeIds = [], meal = 'dinner') {
  const pool = recipes.filter(r => matchesFilters(r, { ...filters, mealTypes: [meal] }));
  const fresh = pool.filter(r => !excludeIds.includes(r.id));
  const from = fresh.length ? fresh : pool;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

// How much to multiply a recipe's ingredients by for a planned slot
export function scaleFactor(recipe, servings) {
  if (!recipe?.servings || !servings) return 1;
  return servings / recipe.servings;
}
