import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeText, parseIngredientLine, parseIngredients } from '../js/parser.js';
import { categorize } from '../js/categorize.js';
import { generatePlan, dateRange, normalizePlan, matchesFilters } from '../js/planner.js';
import { buildShoppingList, scaleIngredientText } from '../js/shopping.js';
import { SAMPLE_RECIPES } from '../js/samples.js';

const recipes = SAMPLE_RECIPES.map((t, i) => {
  const d = parseRecipeText(t);
  const c = categorize(d);
  return { id: 'r' + i, ...d, ...c, ingredients: parseIngredients(d.ingredients) };
});

test('ingredient lines', () => {
  const a = parseIngredientLine('1 1/2 cups (200g) all-purpose flour, sifted');
  assert.equal(a.qty, 1.5); assert.equal(a.unit, 'cup'); assert.equal(a.key, 'all-purpose flour');
  const b = parseIngredientLine('2 (15 oz) cans chickpeas, drained');
  assert.equal(b.qty, 2); assert.equal(b.unit, 'can'); assert.equal(b.key, 'chickpea'); assert.equal(b.note, '15 oz');
  const c = parseIngredientLine('3 cloves garlic, minced');
  assert.equal(c.unit, 'clove'); assert.equal(c.key, 'garlic');
  const d = parseIngredientLine('½ tsp smoked paprika');
  assert.equal(d.qty, 0.5); assert.equal(d.unit, 'tsp');
  const e = parseIngredientLine('4 garlic cloves');
  assert.equal(e.unit, 'clove'); assert.equal(e.key, 'garlic');
  assert.equal(parseIngredientLine('2 T butter').unit, 'tbsp');
  assert.equal(parseIngredientLine('2 large tomatoes, diced').key, 'tomato');
});

test('samples parse and categorize', () => {
  for (const r of recipes) console.log(r.title.padEnd(38), '|', r.mealTypes.join(','), '|', r.proteins.join(','), '|', r.tags.join(','), '|', r.ingredients.length, 'ing', r.steps.length, 'steps');
  for (const r of recipes) { assert.ok(r.ingredients.length >= 5, r.title); assert.ok(r.steps.length >= 1, r.title); }
  const by = t => recipes.find(r => r.title.startsWith(t));
  assert.deepEqual(by('Crispy Chicken').proteins, ['chicken']);
  assert.deepEqual(by('Slow Cooker Turkey').proteins, ['turkey']);
  assert.ok(by('Coconut Chickpea').tags.includes('vegan'));
  assert.ok(by('Classic Banana').mealTypes.includes('baked good'));
  assert.ok(by('Chewy Chocolate').mealTypes.includes('dessert'));
  assert.ok(by('Fluffy Blueberry').mealTypes.includes('breakfast'));
  assert.ok(!by('Creamy Mushroom').tags.includes('vegetarian') === false);
});

test('plan excludes chicken and shopping list merges', () => {
  const dates = dateRange('2026-09-28', '2026-10-04');
  assert.equal(dates.length, 7);
  const { days, warnings } = generatePlan(recipes, { excludeProteins: ['chicken'] }, dates, [], { meals: ['dinner'], avoidBackToBack: true });
  const map = new Map(recipes.map(r => [r.id, r]));
  for (const d of days) { const r = map.get(d.slots.dinner.recipeId); assert.ok(r); assert.ok(!r.proteins.includes('chicken')); assert.ok(r.mealTypes.includes('dinner')); }
  assert.deepEqual(warnings, []);
  const all = { meals: ['dinner'], days: recipes.filter(r => r.mealTypes.includes('dinner')).map(r => ({ date: 'x', slots: { dinner: { recipeId: r.id } } })) };
  const list = buildShoppingList(all, map, ['salt', 'black pepper', 'olive oil'], { overrides: { 'panko': true } });
  assert.equal(list.find(i => i.key === 'garlic').amount.includes('clove'), true);
  assert.equal(list.find(i => i.key === 'panko').have, true);
});

test('breakfast, lunch and dinner slots', () => {
  const dates = dateRange('2026-09-28', '2026-09-30');
  const map = new Map(recipes.map(r => [r.id, r]));
  const { days, warnings } = generatePlan(recipes, {}, dates, [], { meals: ['breakfast', 'lunch', 'dinner'], servings: 2 });
  for (const d of days) {
    assert.ok(map.get(d.slots.breakfast.recipeId).mealTypes.includes('breakfast'));
    assert.ok(map.get(d.slots.dinner.recipeId).mealTypes.includes('dinner'));
    assert.equal(d.slots.dinner.servings, 2);
  }
  assert.ok(warnings.some(w => w.includes('lunch')), 'warns when no lunch recipes exist');
  // locked slots survive a re-shuffle
  days[0].slots.dinner.locked = true;
  const keep = days[0].slots.dinner.recipeId;
  const again = generatePlan(recipes, {}, dates, days, { meals: ['breakfast', 'dinner'] });
  assert.equal(again.days[0].slots.dinner.recipeId, keep);
});

test('old single-dinner plans are upgraded', () => {
  const p = normalizePlan({ start: 'a', end: 'b', days: [{ date: '2026-01-01', recipeId: 'r1', locked: true }, { date: '2026-01-02', skip: true }] });
  assert.deepEqual(p.meals, ['dinner']);
  assert.equal(p.days[0].slots.dinner.recipeId, 'r1');
  assert.equal(p.days[0].slots.dinner.locked, true);
  assert.equal(p.days[1].slots.dinner.skip, true);
});

test('servings scale the shopping list and recipe text', () => {
  const map = new Map(recipes.map(r => [r.id, r]));
  const parm = recipes.find(r => r.title.startsWith('Crispy Chicken'));
  assert.equal(parm.servings, 4);
  const plan = s => ({ meals: ['dinner'], days: [{ date: 'x', slots: { dinner: { recipeId: parm.id, servings: s } } }] });
  const at4 = buildShoppingList(plan(4), map).find(i => i.key === 'spaghetti').amount;
  const at8 = buildShoppingList(plan(8), map).find(i => i.key === 'spaghetti').amount;
  assert.equal(at4, '8 oz');
  assert.equal(at8, '16 oz');
  const panko = parm.ingredients.find(i => i.key === 'panko');
  assert.equal(scaleIngredientText(panko, 2), '2 cups panko breadcrumbs');
  assert.equal(scaleIngredientText(panko, 0.5), '½ cup panko breadcrumbs');
});

test('kitchen filter', () => {
  const r = { title: 'x', mealTypes: ['dinner'], kitchen: 'k1' };
  assert.ok(matchesFilters(r, { kitchens: ['k1'] }));
  assert.ok(!matchesFilters(r, { kitchens: ['k2'] }));
  assert.ok(matchesFilters({ title: 'y' }, { kitchens: ['local'] }));
});
