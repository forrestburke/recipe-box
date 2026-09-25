// Rule-based categorisation. Every result is a suggestion the user can edit on the review screen.

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'dessert', 'baked good', 'snack'];

export const PROTEIN_LIST = ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'fish', 'shellfish', 'tofu', 'legumes', 'eggs'];

const PROTEIN_WORDS = {
  chicken: ['chicken', 'poussin', 'cornish hen'],
  beef: ['beef', 'steak', 'sirloin', 'ribeye', 'rib-eye', 'brisket', 'chuck', 'veal', 'short rib', 'oxtail', 'flank', 'skirt steak', 'tenderloin', 'ground chuck'],
  pork: ['pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'sausage', 'salami', 'pepperoni', 'guanciale', 'lardon', 'bratwurst', 'kielbasa'],
  lamb: ['lamb', 'mutton'],
  turkey: ['turkey'],
  duck: ['duck'],
  fish: ['fish', 'salmon', 'cod', 'tuna', 'tilapia', 'halibut', 'trout', 'haddock', 'mahi mahi', 'snapper', 'sea bass', 'swordfish', 'sardine', 'mackerel', 'pollock', 'catfish', 'sole', 'flounder', 'anchov(?:y|ies)'],
  shellfish: ['shrimp', 'prawn', 'scallop', 'crab', 'lobster', 'mussel', 'clam', 'oyster', 'squid', 'calamari', 'octopus', 'crawfish', 'langoustine'],
  tofu: ['tofu', 'tempeh', 'seitan'],
  legumes: ['lentil', 'chickpea', 'garbanzo', 'black bean', 'kidney bean', 'pinto bean', 'cannellini', 'white bean', 'navy bean', 'edamame', 'split pea', 'butter bean', 'refried bean'],
  eggs: ['egg'],
};
const wordRegex = (words) => new RegExp('\\b(?:' + words.join('|') + ')(?:e?s)?\\b', 'i');
const PROTEIN_RX = Object.fromEntries(Object.entries(PROTEIN_WORDS).map(([k, v]) => [k, wordRegex(v)]));

// Strip ingredients that mention a protein but aren't one (broth, fish sauce, ...)
function stripNonProtein(line) {
  return line
    .replace(/\b(chicken|beef|vegetable|fish|bone|turkey|pork|ham|veal|lamb|duck|shrimp)\s+(broth|stock|bouillon|base|fat|drippings|seasoning|gravy|cube|powder)s?\b/gi, ' ')
    .replace(/\b(fish|oyster|clam|anchovy|shrimp)\s+(sauce|juice|paste)\b/gi, ' ')
    .replace(/\beggplants?\b/gi, ' ');
}

const TAG_RULES = {
  'contains dairy': { rx: wordRegex(['milk', 'butter', 'cheese', 'cream', 'yogh?urt', 'parmesan', 'parmigiano', 'mozzarella', 'cheddar', 'feta', 'ricotta', 'ghee', 'buttermilk', 'mascarpone', 'half-and-half', 'crème fraîche', 'creme fraiche', 'gruyere', 'brie', 'goat cheese', 'pecorino', 'paneer', 'queso']),
    strip: /\b(coconut|almond|oat|soy|rice|cashew)\s+(milk|cream|yogh?urt|butter)|\b(peanut|nut|almond|cashew|cocoa|apple|sun)\s*butter|\bcream of tartar|\bbutternut|\bbutter (beans?|lettuce)|\bice cream\b(?=.*dairy-free)/gi },
  'contains gluten': { rx: wordRegex(['flour', 'bread', 'breadcrumb', 'bread crumb', 'panko', 'pasta', 'spaghetti', 'noodle', 'macaroni', 'penne', 'fettuccine', 'linguine', 'lasagna', 'orzo', 'rigatoni', 'fusilli', 'couscous', 'barley', 'soy sauce', 'wheat', 'cracker', 'pastry', 'pie crust', 'farro', 'bulgur', 'pizza dough', 'beer', 'tortellini', 'ravioli', 'gnocchi', 'bun', 'pita', 'baguette', 'croissant', 'flour tortilla', 'biscuit']),
    strip: /\b(almond|coconut|rice|chickpea|oat|tapioca|corn|cassava|gluten[- ]free)\s+(flour|pasta|noodles?|bread)|\brice noodles?|\bgluten[- ]free\b.*|\btamari\b/gi },
  'contains nuts': { rx: wordRegex(['almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'hazelnut', 'peanut', 'macadamia', 'pine nut', 'nut butter', 'brazil nut', 'praline', 'marzipan', 'nutella']),
    strip: /\bnutmeg|\bbutternut|\bcoconut|\bwater chestnut/gi },
  spicy: { rx: wordRegex(['jalapeño', 'jalapeno', 'chili', 'chile', 'chilli', 'cayenne', 'sriracha', 'red pepper flake', 'chipotle', 'habanero', 'serrano', 'gochujang', 'harissa', 'hot sauce', 'sambal', 'scotch bonnet', 'thai chili']) },
};

const MEAL_RULES = {
  breakfast: /\b(breakfast|brunch|pancakes?|waffles?|french toast|oatmeal|porridge|granola|omelett?es?|frittata|scrambled|smoothie|hash browns?|benedict|shakshuka|overnight oats|crepes?|breakfast burrito|egg muffins?)\b/i,
  dessert: /\b(desserts?|cakes?|cupcakes?|cookies?|brownies?|blondies?|(?<!(pot|shepherd'?s?|cottage|chicken|meat|pork|fish)\s)pies?|puddings?|ice cream|sorbet|cheesecake|mousse|fudge|cobbler|crumble|tiramisu|custard|truffles?|frosting|macarons?|candy|brittle|sundae|panna cotta|trifle|meringue|pavlova|galette|sweet treats?)\b/i,
  'baked good': /\b(breads?|loaf|loaves|muffins?|scones?|biscuits?|(?<!(spring|egg|cabbage|summer|lobster|cinnamon)\s)rolls?|bagels?|focaccia|brioche|croissants?|sourdough|cornbread|pretzels?|buns?|baguettes?|flatbreads?|naan|pita|baked goods?|baking|cinnamon rolls?|danish)\b/i,
  side: /\b(side dish|sides?|slaw|coleslaw|mashed potato(es)?|pilaf|roasted (vegetables|veggies|potatoes|carrots|broccoli)|gratin|dinner rolls?)\b/i,
  lunch: /\b(lunch|sandwich(es)?|wraps?|panini|sliders?|lunchbox)\b/i,
  snack: /\b(snacks?|appetizers?|starters?|dips?|hummus|bites|nachos|finger food|hors d'oeuvres?|canap[eé]s?|energy balls?)\b/i,
  dinner: /\b(dinner|main( course| dish)?|entr[eé]es?|supper|casserole|stir[- ]?fry|curry|roast|lasagna|tacos?|chili|risotto|enchiladas?|burgers?|pasta|stew|bake|skillet|sheet[- ]pan|one[- ]pot|kebabs?|fajitas?|meatballs?|meatloaf|pot pie|shepherd'?s pie|paella|bolognese|carbonara|pad thai)\b/i,
};

const EXTRA_TAGS = {
  soup: /\b(soup|stew|chowder|bisque|broth-based|ramen|pho|gumbo|chili)\b/i,
  salad: /\bsalad\b/i,
  pasta: /\b(pasta|spaghetti|penne|linguine|fettuccine|lasagna|macaroni|rigatoni|orzo|noodles?|gnocchi|ravioli|tortellini)\b/i,
  'slow cooker': /\b(slow[- ]cooker|crock[- ]?pot)\b/i,
  'instant pot': /\b(instant pot|pressure cooker)\b/i,
  grill: /\b(grill(ed)?|bbq|barbecue)\b/i,
  mexican: /\b(mexican|tacos?|enchiladas?|quesadillas?|burritos?|salsa|fajitas?|tortillas?|carnitas|tamales?|pozole|mole)\b/i,
  italian: /\b(italian|risotto|lasagna|parmesan|parmigiana|pesto|bolognese|carbonara|marinara|gnocchi|focaccia|piccata|marsala)\b/i,
  asian: /\b(asian|chinese|japanese|thai|korean|vietnamese|soy sauce|stir[- ]?fry|teriyaki|sesame|ginger|miso|sriracha|gochujang|pad thai|fried rice|ramen|pho|bok choy)\b/i,
  indian: /\b(indian|curry|masala|tikka|garam|tandoori|dal|dahl|biryani|paneer|korma|vindaloo|naan)\b/i,
};

// Returns suggested { mealTypes, proteins, tags }
export function categorize(recipe) {
  const title = recipe.title || '';
  const hints = (recipe.hints || []).join(' ');
  const ingredientText = (recipe.ingredients || []).map(i => typeof i === 'string' ? i : i.raw).join('\n');
  const everything = [title, hints, ingredientText].join('\n');

  // Proteins
  const found = new Set();
  for (const line of ingredientText.split('\n')) {
    const clean = stripNonProtein(line);
    for (const [p, rx] of Object.entries(PROTEIN_RX)) if (rx.test(clean)) found.add(p);
    if (/\b(chicken|turkey)\s+(sausage|bacon|ham)\b/i.test(clean)) found.delete('pork');
  }
  const primary = ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'fish', 'shellfish', 'tofu'].filter(p => found.has(p));
  let proteins = primary;
  if (!proteins.length) {
    proteins = [];
    if (found.has('legumes')) proteins.push('legumes');
    if (found.has('eggs') && (/\b(eggs?|omelett?e|frittata|quiche|shakshuka|benedict)\b/i.test(title) || !proteins.length)) {
      // eggs only count as the main protein when the dish is egg-forward, not a cake that uses two eggs
      if (/\b(eggs?|omelett?e|frittata|quiche|shakshuka|benedict|scramble)\b/i.test(title)) proteins.push('eggs');
    }
  }

  // Meal types
  const mealText = title + ' ' + hints;
  const mealTypes = [];
  for (const [m, rx] of Object.entries(MEAL_RULES)) if (rx.test(mealText)) mealTypes.push(m);
  // pasta, curry etc. in a dessert/breakfast title shouldn't also force dinner
  if (mealTypes.includes('dinner') && (mealTypes.includes('dessert') || mealTypes.includes('breakfast')) && !/\b(dinner|main|entr[eé]e|supper)\b/i.test(mealText)) {
    mealTypes.splice(mealTypes.indexOf('dinner'), 1);
  }
  if (!mealTypes.length) mealTypes.push(primary.length || proteins.length ? 'dinner' : 'dinner');

  // Tags
  const tags = [];
  for (const [t, rule] of Object.entries(TAG_RULES)) {
    const text = rule.strip ? ingredientText.replace(rule.strip, ' ') : ingredientText;
    if (rule.rx.test(text)) tags.push(t);
  }
  for (const [t, rx] of Object.entries(EXTRA_TAGS)) if (rx.test(title + ' ' + hints) || (t === 'pasta' && rx.test(ingredientText))) tags.push(t);

  const meatOrFish = ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'fish', 'shellfish'].some(p => found.has(p))
    || /\b(chicken|beef|fish|pork|turkey|bone)\s+(broth|stock|bouillon)|\bfish sauce|\boyster sauce|\bgelatin|\banchov/i.test(ingredientText);
  if (!meatOrFish) {
    tags.push('vegetarian');
    const hasHoney = /\bhoney\b/i.test(ingredientText);
    if (!tags.includes('contains dairy') && !found.has('eggs') && !hasHoney) tags.push('vegan');
  }
  if (recipe.totalTime && recipe.totalTime <= 30) tags.push('quick');

  return { mealTypes: [...new Set(mealTypes)], proteins: [...new Set(proteins)], tags: [...new Set(tags)] };
}

// Grocery aisle for the shopping list. Order matters: more specific checks first.
const AISLES = [
  ['Frozen', /\bfrozen\b/],
  ['Pantry', /\b(canned|crushed tomato|diced tomato|tomato sauce|tomato paste|stewed tomato|fire[- ]roasted tomato|sauce|salsa)\b/],
  ['Bakery', /\btortillas?\b/],
  ['Spices & Seasonings', /\b(black pepper|peppercorns?|pepper flakes?|salt|cumin|paprika|oregano|cinnamon|chili powder|chile powder|nutmeg|turmeric|cayenne|curry powder|garam masala|bay lea(f|ves)|allspice|cloves? ground|ground cloves?|seasoning|spice|thyme dried|dried (thyme|oregano|basil|rosemary|parsley|dill)|onion powder|garlic powder|coriander|cardamom|smoked paprika|italian seasoning|za'atar|sumac|fennel seed|mustard seed|caraway)\b/],
  ['Baking', /\b(flour|sugar|baking (soda|powder)|yeast|vanilla|cocoa|chocolate chips?|cornstarch|corn starch|powdered sugar|brown sugar|confectioners|molasses|sprinkles|food coloring|shortening|almond extract|gelatin)\b/],
  ['Pantry', /\b(broth|stock|bouillon|canned|can of|tomato paste|tomato sauce|crushed tomato|diced tomato|passata|coconut milk|soy sauce|tamari|fish sauce|oyster sauce|hoisin|sriracha|hot sauce|worcestershire|vinegar|oil|mayonnaise|mayo|ketchup|mustard|honey|maple syrup|jam|peanut butter|tahini|panko|breadcrumbs?|bread crumbs?|rice|pasta|spaghetti|noodles?|macaroni|penne|lasagna|orzo|linguine|fettuccine|rigatoni|fusilli|farfalle|tortellini|ravioli|gnocchi|ramen|udon|soba|bread ?crumbs?|breadcrumb|couscous|quinoa|oats|lentils?|chickpeas?|beans?|salsa|olives?|capers|pickles?|nuts?|almonds?|walnuts?|pecans?|cashews?|raisins|stuffing|crackers?|tortilla chips|pesto|curry paste|miso|gochujang|harissa|wine|sesame seeds?)\b/],
  ['Meat & Seafood', new RegExp('\\b(' + [...PROTEIN_WORDS.chicken, ...PROTEIN_WORDS.beef, ...PROTEIN_WORDS.pork, ...PROTEIN_WORDS.lamb, ...PROTEIN_WORDS.turkey, ...PROTEIN_WORDS.duck, ...PROTEIN_WORDS.fish, ...PROTEIN_WORDS.shellfish, 'ground meat', 'mince', 'meatballs?'].join('|') + ')(e?s)?\\b')],
  ['Dairy & Eggs', /\b(milk|butter|cheese|cream|yogh?urt|parmesan|mozzarella|cheddar|feta|ricotta|ghee|buttermilk|mascarpone|half-and-half|eggs?|sour cream|cream cheese|gruyere|pecorino|brie|paneer|creme fraiche|crème fraîche)\b/],
  ['Bakery', /\b(bread|buns?|rolls?|tortillas?|pitas?|baguettes?|naan|bagels?|croissants?|english muffins?|brioche|ciabatta|sourdough|flatbreads?|pizza dough|pie crust|puff pastry)\b/],
  ['Produce', /\b(onions?|garlic|tomato(es)?|lettuce|spinach|kale|arugula|carrots?|celery|bell peppers?|red pepper|green pepper|yellow pepper|potato(es)?|sweet potato|lemons?|limes?|oranges?|apples?|bananas?|berry|berries|strawberr|blueberr|raspberr|grapes?|cilantro|parsley|basil|thyme|rosemary|mint|dill|sage|chives|ginger|avocados?|cucumbers?|zucchini|courgettes?|mushrooms?|broccoli|cauliflower|cabbage|scallions?|green onions?|spring onions?|shallots?|leeks?|squash|pumpkin|corn|jalapeños?|jalapenos?|chil(i|e|li)s?|eggplants?|aubergine|asparagus|green beans?|peas|bok choy|fennel|radish|beets?|mango|pineapple|peach|pear|herbs?|lemongrass|sprouts|tofu|tempeh)\b/],
];

export function aisleFor(key) {
  for (const [aisle, rx] of AISLES) if (rx.test(key)) return aisle;
  return 'Other';
}
export const AISLE_ORDER = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry', 'Baking', 'Spices & Seasonings', 'Frozen', 'Other'];
