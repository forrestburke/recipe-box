# Recipe Box & Meal Planner

A personal recipe library that imports recipes from **links, photos, scans, PDFs or pasted text**, auto-categorises them, generates a **random dinner plan** for any date range (with filters like "no chicken this week"), and builds an editable **shopping list** you can print or export.

No AI services, no build step, no framework — plain HTML/CSS/JavaScript that runs in any modern browser.

## How recipe import works (without AI)

| Source | How it's read | Accuracy |
|---|---|---|
| **Recipe link** | Almost every recipe site embeds [schema.org Recipe](https://schema.org/Recipe) data for Google. The app reads that structured data directly. | Exact on most sites |
| **Bookmark button** | For sites that block server requests (AllRecipes, Serious Eats…), a bookmarklet reads the same structured data from the page in *your* browser and sends it to the app. | Exact |
| **Photo / scan (JPEG, PNG)** | [Tesseract.js](https://tesseract.projectnaptha.com/) OCR, running entirely in your browser, then heuristics that find the "Ingredients" / "Method" sections, quantities and units. | Good on clean prints; always reviewed before saving |
| **PDF** | [pdf.js](https://mozilla.github.io/pdf.js/) extracts the text layer; scanned PDFs with no text are OCR'd page by page. | Good |
| **Pasted text** | Same text heuristics. | Good |

Every import lands on a **review screen** where you can fix the title, ingredients, steps and categories before saving.

**Categorisation** is rule-based: keyword lists detect the main protein (chicken, beef, pork, fish, shellfish, tofu, legumes, eggs…), meal type (breakfast, dinner, dessert, baked good…), and tags (vegetarian, vegan, contains dairy/gluten/nuts, spicy, cuisine, quick). It ignores false positives such as "chicken broth" or "fish sauce", and you can override anything.

## Features

- **Library**: search, filter by meal type or protein, view, edit, print or delete recipes
- **Editable ingredients**: every ingredient is a row with amount, unit and name, plus the name it uses on the shopping list (🛒). Items with the same shopping-list name are combined. You can add, remove and reorder rows, or switch to "Edit as text" to paste a whole list.
- **Dish photos**: link imports use the site's own photo. Other recipes get a photo looked up by dish name from Wikipedia, Wikimedia Commons and TheMealDB (free, openly licensed, no API key). A photo is added automatically only when the match is confident. Otherwise use **Edit → Find photos** to choose one, upload your own, or paste an image link. Credits are shown on the photo.
- **Meal plan**: pick start and end dates, choose meal types, exclude proteins/tags/ingredients, require vegetarian/vegan/quick, avoid the same protein two nights running. Per night you can swap 🔀, lock 🔒 (kept when re-shuffling), skip 🚫 (eating out), or pick a specific recipe.
- **Shopping list**: merges quantities across recipes (e.g. 1 tbsp + ½ cup), groups by aisle and shows which recipe needs each item. Tick "have it" to drop an item (e.g. panko). ⭐ adds it to your **always-have pantry** so it's ticked on every future list. You can add your own items and then print, copy, share, or download as .txt or .csv.
- **Backup**: export or import your whole library as JSON
- **Optional cloud sync**: Firebase Auth (Google sign-in) plus Firestore, so your phone and computer share one library

## Run locally

Requires Node.js 18+ (no `npm install` needed for local dev).

```bash
node server.js
```

Open http://localhost:5173. Go to **Settings → Load sample recipes** to try it with 15 recipes.

Run the logic tests:

```bash
npm test
```

## Project layout

```
index.html            App shell
css/styles.css        Styles (light/dark, mobile, print)
js/app.js             UI controller
js/parser.js          JSON-LD, microdata and text/OCR recipe parsing; ingredient line parser
js/categorize.js      Protein / meal type / tag rules; grocery aisles
js/planner.js         Date ranges, filters, random plan generation
js/shopping.js        Ingredient merging, unit conversion, text/CSV export
js/importers.js       URL fetch, OCR (Tesseract.js), PDF (pdf.js)
js/images.js          Dish photo lookup (Wikipedia, Commons, TheMealDB) and photo upload
js/store.js           localStorage + optional Firestore sync
js/config.js          ← your settings (Firebase config, fetch endpoint)
js/samples.js         Sample recipes
server.js             Local dev server (static files + /api/fetch)
functions/            Firebase Cloud Function that fetches recipe pages
firebase.json         Hosting + rewrite /api/fetch → function
firestore.rules       Each user can only access their own data
```

## Deploy to Firebase (recommended)

1. Create a project at https://console.firebase.google.com.
2. **Build → Authentication → Get started → Google** (enable it).
3. **Build → Firestore Database → Create database** (production mode).
4. **Project settings → Your apps → Web app (</>)**: copy the config object into `firebase:` in `js/config.js`.
5. Install the CLI and deploy:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add            # pick your project
   cd functions && npm install && cd ..
   firebase deploy
   ```
6. In **Authentication → Settings → Authorized domains**, make sure your `*.web.app` domain is listed. It's added automatically in most cases.

> **Cost note:** Cloud Functions require the pay-as-you-go **Blaze** plan (a card on file). Personal use sits comfortably inside the free monthly allowance (2M function calls), so the expected cost is $0. Set a budget alert in Google Cloud to be safe. If you'd rather not add billing, deploy with `firebase deploy --only hosting,firestore`. Link import will then show an error, but the **bookmark button**, photo/PDF and paste imports all still work, because they don't need the server.

### Auto-deploy from GitHub

Push this folder to a GitHub repo, then run `firebase init hosting:github`. It creates a GitHub Action that deploys hosting on every push to `main`. Deploy functions manually with `firebase deploy --only functions` when you change them.

### GitHub Pages instead?

GitHub Pages can host the app as-is: push the repo and enable Pages. It can't run the fetch function, so use the bookmark button for web recipes. Cloud sync still works if you add your Firebase config and authorize the `*.github.io` domain in Firebase Auth.

## Limitations & ideas

- OCR quality depends on the photo: flat, well-lit, one recipe per image works best. Two-column layouts may need tidying on the review screen (or edit the scanned text and click **Re-read**).
- Unit merging combines within volume (tsp/tbsp/cup/ml) and weight (g/oz/lb); it doesn't convert volume to weight.
- Ideas for later: scaling servings, planning breakfast/lunch too, "use up what I have" suggestions, PWA install + share target so you can share a link from your phone straight into the app.
