// Data layer. Everything lives in an in-memory cache, persisted to localStorage,
// and mirrored to a shared Firestore "household" when Firebase is configured and the user is signed in.
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
let cloud = null; // { uid, email, name, db, fs, hid, members, owner } when signed in
let cloudError = '';
const notify = (changed) => listeners.forEach(fn => fn(changed));

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) data = { ...defaults(), ...JSON.parse(raw) };
  } catch (e) { console.warn('Could not read saved data', e); }
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { alert('Could not save to this browser (storage full?). Export a backup from Settings.'); }
}

function persist(changed) {
  data.updatedAt = Date.now();
  saveLocal();
  if (cloud) pushCloud(changed).catch(e => { console.warn('Cloud sync failed', e); cloudError = 'Sync failed: ' + e.message; notify({ cloud: true }); });
  notify(changed);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const store = {
  init() { load(); if (config.firebase) initCloud().catch(e => { cloudError = e.message; notify({ cloud: true }); }); },
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

  cloudStatus() {
    if (!config.firebase) return null;
    if (!cloud) return { signedIn: false, error: cloudError };
    return { signedIn: true, name: cloud.name, email: cloud.email, members: cloud.members, isOwner: cloud.owner === cloud.uid, error: cloudError };
  },
  signIn: () => cloudSignIn(),
  signOut: () => cloudSignOut(),
  addMember: (email) => updateMembers(email, 'add'),
  removeMember: (email) => updateMembers(email, 'remove'),
};

// ---------- Firebase sync: one shared library per household ----------
// Firestore layout:
//   households/{hid}                 { owner: uid, members: [emails] }   hid = uid of the person who created it
//   households/{hid}/recipes/{id}    one document per recipe
//   households/{hid}/meta/state      { plan, shopping, settings, updatedAt }  shared meal plan + list
// Anyone whose Google email is in `members` can read and write it (see firestore.rules).
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
let fbAuth = null, fbMods = null, unsubscribers = [];
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore rejects undefined

async function initCloud() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(config.firebase);
  fbMods = { auth, fs };
  fbAuth = auth.getAuth(app);
  const db = fs.getFirestore(app);
  auth.getRedirectResult(fbAuth).catch(() => {});
  auth.onAuthStateChanged(fbAuth, async (user) => {
    unsubscribers.forEach(u => u());
    unsubscribers = [];
    cloud = null;
    cloudError = '';
    if (!user) return notify({ cloud: true });
    const email = (user.email || '').toLowerCase();
    try {
      const hh = await findOrCreateHousehold(db, fs, user.uid, email);
      cloud = { uid: user.uid, email, name: user.displayName || user.email, db, fs, hid: hh.id, members: hh.members, owner: hh.owner };
      await joinHousehold();
      listenForChanges();
    } catch (e) {
      console.error(e);
      cloud = null;
      cloudError = 'Could not connect to your shared library: ' + e.message;
    }
    notify({ all: true, cloud: true });
  });
}

// Use a household you've been added to (prefer a shared one), otherwise create your own
async function findOrCreateHousehold(db, fs, userId, email) {
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'households'), fs.where('members', 'array-contains', email)));
  const found = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.members.length - a.members.length) || ((a.owner === userId) - (b.owner === userId)));
  if (found.length) return found[0];
  const hh = { owner: userId, members: [email], createdAt: Date.now() };
  await fs.setDoc(fs.doc(db, 'households', userId), hh);
  return { id: userId, ...hh };
}

const hhPath = (...p) => [cloud.db, 'households', cloud.hid, ...p];

async function joinHousehold() {
  const { fs } = cloud;
  const joinedKey = `recipe-planner.joined.${cloud.hid}`;
  const lastSync = +localStorage.getItem(joinedKey) || 0;
  const remote = (await fs.getDocs(fs.collection(...hhPath('recipes')))).docs.map(d => d.data());
  const remoteIds = new Set(remote.map(r => r.id));

  // Recipes only in this browser: upload them the first time this browser joins, or if edited since the last sync.
  // Otherwise they were deleted by someone else, so drop them.
  const localOnly = data.recipes.filter(r => !remoteIds.has(r.id));
  const upload = localOnly.filter(r => !lastSync || (r.updatedAt || 0) > lastSync);

  const byId = new Map(remote.map(r => [r.id, r]));
  for (const r of data.recipes) {
    const other = byId.get(r.id);
    if (other ? (r.updatedAt || 0) > (other.updatedAt || 0) : upload.includes(r)) byId.set(r.id, r);
  }
  const newer = data.recipes.filter(r => remoteIds.has(r.id) && byId.get(r.id) === r);
  data.recipes = [...byId.values()];

  const stateSnap = await fs.getDoc(fs.doc(...hhPath('meta', 'state')));
  const s = stateSnap.exists() ? stateSnap.data() : null;
  if (s && (s.updatedAt || 0) >= (data.updatedAt || 0)) Object.assign(data, { plan: s.plan ?? null, shopping: s.shopping || data.shopping, settings: s.settings || data.settings, updatedAt: s.updatedAt });
  saveLocal();

  for (const r of [...upload, ...newer]) await fs.setDoc(fs.doc(...hhPath('recipes', r.id)), clean(r));
  if (!s || (s.updatedAt || 0) < (data.updatedAt || 0)) await pushState();
  localStorage.setItem(joinedKey, String(Date.now()));
}

// Live updates when the other person changes something
function listenForChanges() {
  const { fs } = cloud;
  const joinedKey = `recipe-planner.joined.${cloud.hid}`;
  unsubscribers.push(fs.onSnapshot(fs.collection(...hhPath('recipes')), snap => {
    if (snap.metadata.hasPendingWrites) return; // our own write echoing back
    let changed = false;
    for (const ch of snap.docChanges()) {
      const r = ch.doc.data();
      const i = data.recipes.findIndex(x => x.id === ch.doc.id);
      if (ch.type === 'removed') { if (i !== -1) { data.recipes.splice(i, 1); changed = true; } }
      else if (i === -1) { data.recipes.push(r); changed = true; }
      else if ((r.updatedAt || 0) > (data.recipes[i].updatedAt || 0)) { data.recipes[i] = r; changed = true; }
    }
    if (changed) { saveLocal(); notify({ all: true, remote: true }); }
    localStorage.setItem(joinedKey, String(Date.now()));
  }, e => { cloudError = 'Live sync stopped: ' + e.message; notify({ cloud: true }); }));

  unsubscribers.push(fs.onSnapshot(fs.doc(...hhPath('meta', 'state')), snap => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const s = snap.data();
    if ((s.updatedAt || 0) > (data.updatedAt || 0)) {
      Object.assign(data, { plan: s.plan ?? null, shopping: s.shopping || data.shopping, settings: s.settings || data.settings, updatedAt: s.updatedAt });
      saveLocal();
      notify({ all: true, remote: true });
    }
  }));

  unsubscribers.push(fs.onSnapshot(fs.doc(cloud.db, 'households', cloud.hid), snap => {
    if (snap.exists() && cloud) { cloud.members = snap.data().members; notify({ cloud: true }); }
  }));
}

function pushState() {
  return cloud.fs.setDoc(fs_doc('meta', 'state'), clean({ plan: data.plan, shopping: data.shopping, settings: data.settings, updatedAt: data.updatedAt }));
}
const fs_doc = (...p) => cloud.fs.doc(...hhPath(...p));

async function pushCloud(changed) {
  const { fs } = cloud;
  if (changed.recipe) await fs.setDoc(fs_doc('recipes', changed.recipe.id), clean(changed.recipe));
  if (changed.deletedRecipe) await fs.deleteDoc(fs_doc('recipes', changed.deletedRecipe));
  if (changed.all) for (const r of data.recipes) await fs.setDoc(fs_doc('recipes', r.id), clean(r));
  if (changed.all || changed.plan || changed.shopping || changed.settings) await pushState();
}

async function updateMembers(email, action) {
  if (!cloud) throw new Error('Sign in first');
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address');
  if (action === 'remove' && e === cloud.email) throw new Error("You can't remove yourself");
  const { fs } = cloud;
  await fs.updateDoc(fs.doc(cloud.db, 'households', cloud.hid), { members: action === 'add' ? fs.arrayUnion(e) : fs.arrayRemove(e) });
}

async function cloudSignIn() {
  if (!fbAuth) throw new Error('Cloud sync is still loading — try again in a moment');
  const provider = new fbMods.auth.GoogleAuthProvider();
  try { await fbMods.auth.signInWithPopup(fbAuth, provider); }
  catch (e) {
    // Some phones block popups: fall back to a full-page redirect
    if (/popup-blocked|operation-not-supported|popup-closed-by-browser/.test(e.code || '')) await fbMods.auth.signInWithRedirect(fbAuth, provider);
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') throw e;
  }
}
async function cloudSignOut() { if (fbAuth) await fbMods.auth.signOut(fbAuth); }
