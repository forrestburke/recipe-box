// Find a photo of the dish by name, using free open image sources that allow browser requests:
//   TheMealDB (recipe photos), Wikipedia article images, Wikimedia Commons (CC-licensed photos).
// Imports from a recipe website already carry the site's own photo, so this is for scans, pastes and typed recipes.

const FILLER = new Set([
  'easy', 'quick', 'best', 'classic', 'simple', 'weeknight', 'homemade', 'perfect', 'ultimate', 'healthy', 'my', 'the', 'recipe',
  'mom', "mom's", 'moms', 'grandma', "grandma's", 'grandmas', "world's", 'worlds', 'favorite', 'favourite', 'famous', 'amazing',
  'delicious', 'authentic', 'traditional', 'minute', 'minutes', 'fluffy', 'chewy', 'creamy', 'crispy', 'super', 'a', 'an', 'with', 'and', 'of', 'in', 'on',
  'slow', 'cooker', 'crockpot', 'sheet', 'pan', 'instant', 'pot', 'one', 'jpg', 'jpeg', 'png', 'food', 'dish',
]);

// Auto-assign only when at least half the dish words match
export const CONFIDENT = 0.5;

const words = s => s.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(w => w.length > 1 && !FILLER.has(w));

export function dishQuery(title) {
  return words(title || '').join(' ');
}

// recall: share of the dish words found; precision: share of the candidate's words that are dish words
function match(candidateTitle, queryWords) {
  const stem = w => w.replace(/e?s$/, '');
  const cw = [...new Set(words(candidateTitle.replace(/^File:/, '').replace(/\.\w+$/, '')).map(stem))];
  const q = new Set(queryWords.map(stem));
  const hits = cw.filter(w => q.has(w)).length;
  return { recall: hits / q.size, precision: cw.length ? hits / cw.length : 0 };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function fromMealDb(q) {
  const data = await getJson(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`);
  return (data.meals || []).slice(0, 4).map(m => ({ url: m.strMealThumb, thumb: m.strMealThumb + '/preview', title: m.strMeal, credit: 'TheMealDB', page: `https://www.themealdb.com/meal/${m.idMeal}` }));
}

async function fromWikipedia(q) {
  const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q + ' food')}&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=800`);
  return Object.values(data.query?.pages || {})
    .filter(p => p.thumbnail?.source && !/\.svg/i.test(p.thumbnail.source))
    .sort((a, b) => a.index - b.index)
    .map(p => ({ url: p.thumbnail.source, thumb: p.thumbnail.source, title: p.title, credit: 'Wikipedia', page: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}` }));
}

async function fromCommons(q) {
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&gsrlimit=10&prop=imageinfo&iiprop=url&iiurlwidth=800`);
  return Object.values(data.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .filter(p => p.imageinfo?.[0]?.thumburl)
    .map(p => ({ url: p.imageinfo[0].thumburl, thumb: p.imageinfo[0].thumburl, title: p.title.replace(/^File:/, ''), credit: 'Wikimedia Commons', page: p.imageinfo[0].descriptionurl }));
}

// Returns candidates, best match first. Tries the full dish name, then drops leading words ("Chicken Parmesan" -> "Parmesan").
export async function findDishImages(title, { limit = 12 } = {}) {
  const all = words(title || '');
  if (!all.length) return [];
  const seen = new Set();
  const results = [];
  for (let start = 0; start < all.length && results.length < limit; start++) {
    const qWords = all.slice(start);
    if (start > 0 && qWords.length < 2 && results.length) break;
    const q = qWords.join(' ');
    const batches = await Promise.all([fromMealDb(q), fromWikipedia(q), fromCommons(q)].map(p => p.catch(() => [])));
    batches.forEach((batch, sourceRank) => batch.forEach((c, i) => {
      if (seen.has(c.url)) return;
      const m = match(c.title, all);
      if (m.recall === 0) return; // nothing in common with the dish name: probably unrelated
      seen.add(c.url);
      results.push({ ...c, recall: m.recall, score: m.recall + 0.3 * m.precision - sourceRank * 0.01 - i * 0.002 });
    }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Downscale a user's own photo to a small JPEG data URL so it fits in storage
export async function photoToDataUrl(file, max = 900) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}
