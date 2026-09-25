// Data layer. Everything lives in an in-memory cache, persisted to localStorage,
// and mirrored to Firestore when Firebase is configured and the user is signed in.
import { config } from './config.js';

const KEY = 'recipe-planner.v1';

const DEFAULT_PANTRY = ['salt', 'black pepper', 'olive oil', 'vegetable oil', 'water', 'sugar', 'all-purpose flour'];

function defaults() {
  return {
    recipes: [],
    plan: null,
    shopping: { overrides: {}, custom: [] },
    settings: {
      pantry: DEFAULT_PANTRY,
      filters: { mealTypes: ['dinner'], excludeProteins: [], excludeTags: [], requireTags: [], excludeIngredients: '' },
      avoidBackToBack: true,
    },
    updatedAt: 0,
  };
}

let data = defaults();
const listeners = new Set();
let cloud = null; // { uid, db, fs } when signed in

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) data = { ...defaults(), ...JSON.parse(raw) };
  } catch (e) { console.warn('Could not read saved data', e); }
}

function persist(changed) {
  data.updatedAt = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { alert('Could not save to this browser (storage full?). Export a backup from Settings.'); }
  if (cloud) pushCloud(changed).catch(e => console.warn('Cloud sync failed', e));
  listeners.forEach(fn => fn(changed));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const store = {
  init() { load(); if (config.firebase) initCloud(); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  recipes() { return data.recipes; },
  recipeMap() { return new Map(data.recipes.map(r => [r.id, r])); },
  getRecipe(id) { return data.recipes.find(r => r.id === id); },
  saveRecipe(r) {
    r = { ...r, id: r.id || uid(), updatedAt: Date.now(), createdAt: r.createdAt || Date.now() };
    const i = data.recipes.findIndex(x => x.id === r.id);
    if (i === -1) data.recipes.push(r); else data.recipes[i] = r;
    persist({ recipe: r });
    return r;
  },
  deleteRecipe(id) {
    data.recipes = data.recipes.filter(r => r.id !== id);
    persist({ deletedRecipe: id });
  },

  get(key) { return data[key]; },
  set(key, value) { data[key] = value; persist({ [key]: true }); },
  settings() { return data.settings; },
  updateSettings(patch) { data.settings = { ...data.settings, ...patch }; persist({ settings: true }); },

  exportJSON() { return JSON.stringify({ app: 'recipe-planner', version: 1, ...data }, null, 2); },
  importJSON(text, mode = 'merge') {
    const incoming = JSON.parse(text);
    if (!Array.isArray(incoming.recipes)) throw new Error('Not a recipe-planner backup file');
    if (mode === 'replace') data = { ...defaults(), ...incoming };
    else {
      const byId = new Map(data.recipes.map(r => [r.id, r]));
      for (const r of incoming.recipes) byId.set(r.id, r);
      data.recipes = [...byId.values()];
    }
    persist({ all: true });
  },

  cloudStatus() { return config.firebase ? (cloud ? { signedIn: true, name: cloud.name } : { signedIn: false }) : null; },
  signIn: () => cloudSignIn(),
  signOut: () => cloudSignOut(),
};

// ---------- Optional Firebase sync ----------
// Firestore layout: users/{uid}/recipes/{recipeId}  and  users/{uid}/meta/state  (plan, shopping, settings)
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
let fbAuth = null, fbMods = null;

async function initCloud() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(config.firebase);
  fbMods = { auth, fs };
  fbAuth = auth.getAuth(app);
  const db = fs.getFirestore(app);
  auth.onAuthStateChanged(fbAuth, async (user) => {
    if (!user) { cloud = null; listeners.forEach(fn => fn({ cloud: true })); return; }
    cloud = { uid: user.uid, name: user.displayName || user.email, db, fs };
    await pullCloud();
  });
}

async function cloudSignIn() {
  if (!fbAuth) return;
  await fbMods.auth.signInWithPopup(fbAuth, new fbMods.auth.GoogleAuthProvider());
}
async function cloudSignOut() { if (fbAuth) await fbMods.auth.signOut(fbAuth); }

async function pullCloud() {
  const { fs, db, uid: u } = cloud;
  const snap = await fs.getDocs(fs.collection(db, 'users', u, 'recipes'));
  const remote = snap.docs.map(d => d.data());
  const stateSnap = await fs.getDoc(fs.doc(db, 'users', u, 'meta', 'state'));
  if (!remote.length && !stateSnap.exists()) {
    // First sign-in: upload what's in this browser
    await pushCloud({ all: true });
  } else {
    const byId = new Map(data.recipes.map(r => [r.id, r]));
    for (const r of remote) if (!byId.has(r.id) || (r.updatedAt || 0) >= (byId.get(r.id).updatedAt || 0)) byId.set(r.id, r);
    data.recipes = [...byId.values()];
    if (stateSnap.exists()) {
      const s = stateSnap.data();
      if ((s.updatedAt || 0) > (data.updatedAt || 0)) Object.assign(data, { plan: s.plan ?? null, shopping: s.shopping, settings: s.settings });
    }
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
    const localOnly = data.recipes.filter(r => !remote.some(x => x.id === r.id));
    for (const r of localOnly) await fs.setDoc(fs.doc(db, 'users', u, 'recipes', r.id), r);
  }
  listeners.forEach(fn => fn({ all: true, cloud: true }));
}

async function pushCloud(changed) {
  const { fs, db, uid: u } = cloud;
  const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore rejects undefined
  if (changed.recipe) await fs.setDoc(fs.doc(db, 'users', u, 'recipes', changed.recipe.id), clean(changed.recipe));
  if (changed.deletedRecipe) await fs.deleteDoc(fs.doc(db, 'users', u, 'recipes', changed.deletedRecipe));
  if (changed.all) for (const r of data.recipes) await fs.setDoc(fs.doc(db, 'users', u, 'recipes', r.id), clean(r));
  await fs.setDoc(fs.doc(db, 'users', u, 'meta', 'state'), clean({ plan: data.plan, shopping: data.shopping, settings: data.settings, updatedAt: data.updatedAt }));
}
