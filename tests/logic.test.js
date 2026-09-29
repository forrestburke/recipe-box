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

import { parseCsv, recipesFromCsv, csvTemplate } from '../js/csv.js';
import { splitPastedRecipes } from '../js/importers.js';

test('CSV import: template round-trip, semicolons, multi-line cells', () => {
  const { drafts, skipped } = recipesFromCsv(csvTemplate());
  assert.equal(drafts.length, 2); assert.equal(skipped, 0);
  assert.equal(drafts[0].title, "Grandma's Meatloaf");
  assert.equal(drafts[0].ingredients.length, 5);
  assert.equal(drafts[0].steps.length, 3);
  assert.deepEqual(drafts[0].mealTypes, ['dinner']);
  assert.equal(drafts[1].ingredients.length, 5, 'pipe-separated');
  assert.equal(drafts[1].proteins, undefined, 'blank protein left for auto-detect');
  const semi = 'Title;Ingredients;Instructions\r\n"Soup";"1 onion\n2 carrots";"Chop; simmer"\r\n;;\r\n';
  const r = recipesFromCsv(semi);
  assert.equal(r.drafts.length, 1);
  assert.deepEqual(r.drafts[0].ingredients, ['1 onion', '2 carrots']);
  assert.deepEqual(parseCsv('a,"b ""q"" c",d'), [['a', 'b "q" c', 'd']]);
  assert.throws(() => recipesFromCsv('name,foo\nx,y'), /ingredients/);
});

import { looksLikeContinuation, isBlankPage, isWeak } from '../js/bulk.js';

test('bulk: page joining, blank pages, weak recipes, pasted batches', () => {
  assert.ok(looksLikeContinuation('2. Add onions and cook.\n3. Simmer for two hours.'));
  assert.ok(!looksLikeContinuation('Beef Stew\nIngredients\n2 lb beef\n1 onion\nDirections\nCook it.'));
  assert.ok(!looksLikeContinuation('Pancakes\n2 cups flour\n2 eggs\n1 cup milk\nMix and fry.'));
  assert.ok(isBlankPage('  \n . '));
  assert.ok(!isBlankPage('Lemon Bars\n1 cup butter'));
  assert.ok(isWeak({ ingredients: ['a', 'b'], steps: ['x'] }, 'Soup'));
  assert.ok(isWeak({ ingredients: ['a', 'b', 'c'], steps: [] }, 'Soup'));
  assert.ok(isWeak({ ingredients: ['a', 'b', 'c'], steps: ['x'] }, ''));
  assert.ok(!isWeak({ ingredients: ['a', 'b', 'c'], steps: ['x'] }, 'Soup'));
  assert.equal(splitPastedRecipes('Soup\n1 cup water\n---\nBread\n2 cups flour\n===\nTea\n1 tea bag and water').length, 3);
  assert.equal(splitPastedRecipes('Just one recipe\n1 cup rice').length, 1);
});

import { readFileSync } from 'node:fs';
import { googleDocId } from '../js/importers.js';

test('Google Doc recipe: no Directions heading, paragraphs as steps', () => {
  const text = readFileSync(new URL('./fixtures/google-doc-recipe.txt', import.meta.url), 'utf8');
  const d = parseRecipeText(text);
  assert.equal(d.title, 'Cinnamon Swirl Loaf');
  assert.equal(d.ingredients.length, 10);
  assert.ok(d.ingredients.at(-1).startsWith('Cinnamon sugar'));
  assert.equal(d.steps.length, 10);
  assert.ok(d.steps[3].startsWith('While mixing on low'));
  assert.equal(googleDocId('https://docs.google.com/document/d/1AxWfzg4M69PWOAhC1ZVc1I56AUE09-m6pkknL5BmmA0/edit?tab=t.0'), '1AxWfzg4M69PWOAhC1ZVc1I56AUE09-m6pkknL5BmmA0');
  assert.equal(googleDocId('https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit'), null);
});

test('combined ingredient lines are split', () => {
  const cs = parseIngredients(['Cinnamon sugar - ½ C sugar and 2 T of cinnamon']);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.map(i => [i.qty, i.unit, i.key]), [[0.5, 'cup', 'sugar'], [2, 'tbsp', 'cinnamon']]);
  assert.ok(cs.every(i => i.raw === 'Cinnamon sugar - ½ C sugar and 2 T of cinnamon' && i.note.includes('cinnamon sugar')));
  assert.equal(parseIngredients(['For the glaze: 1 cup powdered sugar, 2 tbsp milk']).length, 2);
  assert.equal(parseIngredients(['1 cup sugar and 2 tbsp cinnamon']).length, 2);
  const flour = parseIngredients(['4 and 1/2 cups flour']);
  assert.equal(flour.length, 1); assert.equal(flour[0].qty, 4.5);
  assert.equal(parseIngredients(['2 tablespoons butter plus more for greasing']).length, 1);
  assert.equal(parseIngredients(['1 (14 oz) can tomatoes']).length, 1);
});


import { categorize as categorizeR } from '../js/categorize.js';
import { isPantryItem, scaleIngredientText as scaleR, formatQty as fmtR } from '../js/shopping.js';
import { matchesFilters as mf, generatePlan as gp, dateRange as dr } from '../js/planner.js';
import { cleanOcrText, isoDurationToMinutes, parseQuantity } from '../js/parser.js';

test('review fixes: ingredient parsing', () => {
  const one = (t) => parseIngredients([t]);
  assert.equal(one('1 lb. boneless, skinless chicken breasts')[0].key, 'chicken breast');
  assert.equal(one('1-1/2 cups flour')[0].qty, 1.5);
  assert.equal(parseQuantity('1-1/2').qty, 1.5);
  assert.equal(one('2-3 cloves garlic')[0].qtyMax, 3);
  assert.equal(one('1 cup hot sauce')[0].key, 'hot sauce');
  assert.equal(one('2 cups hot water')[0].key, 'water');
  assert.equal(one('1 dozen eggs')[0].qty, 12);
  assert.deepEqual([one('juice of 2 limes')[0].qty, one('juice of 2 limes')[0].key], [2, 'lime']);
  assert.equal(one('2,5 dl milk')[0].unit, 'dl');
  assert.equal(scaleR(parseIngredientLine('3 garlic cloves'), 2), '6 cloves garlic');
  assert.deepEqual(parseIngredients([null, 123, '1 cup rice']).map(i => i.key), ['rice']);
  assert.equal(cleanOcrText('Bake at 350o F'), 'Bake at 350° F');
  assert.equal(cleanOcrText('Simmer 9o minutes'), 'Simmer 90 minutes');
  assert.equal(isoDurationToMinutes('PT0.5H'), 30);
});

test('review fixes: categorising', () => {
  const cat = (title, ings) => categorizeR({ title, ingredients: ings });
  assert.ok(!cat('Bolognese', ['1 lb ground meat']).tags.includes('vegetarian'));
  assert.deepEqual(cat('Roast Pork', ['1 pork tenderloin']).proteins, ['pork']);
  assert.deepEqual(cat('Cauliflower Steaks', ['1 head cauliflower, cut into steaks']).proteins, []);
  assert.deepEqual(cat('Chicken Larb', ['1 lb chicken mince']).proteins, ['chicken']);
  assert.deepEqual(cat('Crab Cakes', ['1 lb crab meat']).mealTypes, ['dinner']);
  assert.ok(!cat('Dinner Rolls', ['3 cups flour']).mealTypes.includes('dinner'));
  assert.deepEqual(categorizeR({ title: 'X', ingredients: [null, { raw: '1 lb beef' }] }).proteins, ['beef']);
});

test('review fixes: pantry, filters, planning', () => {
  assert.ok(isPantryItem('egg', ['eggs']));
  assert.ok(!isPantryItem('red bell pepper', ['pepper']));
  assert.ok(!isPantryItem('peanut butter', ['butter']));
  assert.equal(fmtR(0.03), '0.03');
  const r = (id, ing) => ({ id, title: id, mealTypes: ['dinner'], ingredients: parseIngredients(ing) });
  assert.ok(mf(r('a', ['1 cup graham crackers']), { excludeIngredients: 'ham' }));
  assert.ok(mf(r('b', ['1 eggplant']), { excludeIngredients: 'egg' }));
  assert.ok(!mf(r('c', ['1 mushroom']), { excludeIngredients: 'mushrooms' }));
  assert.ok(mf({ id: 'x', title: 'X' }, { mealTypes: ['dinner'] }));
  const three = [r('a', ['1 cup rice']), r('b', ['1 cup rice']), r('c', ['1 cup rice'])];
  const dates = dr('2026-10-01', '2026-10-10');
  for (let k = 0; k < 100; k++) {
    const { days } = gp(three, {}, dates, [], { meals: ['dinner'] });
    for (let i = 1; i < days.length; i++) assert.notEqual(days[i].slots.dinner.recipeId, days[i - 1].slots.dinner.recipeId);
  }
  const first = gp(three, {}, dates, [], { meals: ['dinner'] }).days;
  first[0].slots.dinner.servings = 7;
  assert.equal(gp(three, {}, dates, first, { meals: ['dinner'] }).days[0].slots.dinner.servings, 7);
});
