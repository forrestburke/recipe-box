import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeText, parseIngredientLine, parseIngredients } from '../js/parser.js';
import { categorize } from '../js/categorize.js';
import { generatePlan, dateRange } from '../js/planner.js';
import { buildShoppingList } from '../js/shopping.js';
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
  const { days, warnings } = generatePlan(recipes, { mealTypes: ['dinner'], excludeProteins: ['chicken'] }, dates, [], { avoidBackToBack: true });
  const map = new Map(recipes.map(r => [r.id, r]));
  for (const d of days) { const r = map.get(d.recipeId); assert.ok(r); assert.ok(!r.proteins.includes('chicken')); assert.ok(r.mealTypes.includes('dinner')); }
  console.log(days.map(d => map.get(d.recipeId).title), warnings);
  const all = { days: recipes.filter(r => r.mealTypes.includes('dinner')).map(r => ({ date: 'x', recipeId: r.id })) };
  const list = buildShoppingList(all, map, ['salt', 'black pepper', 'olive oil'], { overrides: { 'panko': true } });
  for (const i of list) console.log(i.aisle.padEnd(20), i.have ? '[x]' : '[ ]', i.name.padEnd(28), i.amount);
  assert.equal(list.find(i => i.key === 'garlic').amount.includes('clove'), true);
  assert.equal(list.find(i => i.key === 'panko').have, true);
});
