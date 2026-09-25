// Firebase Cloud Function: GET /api/fetch?url=...  (wired up by the rewrite in ../firebase.json)
import { onRequest } from 'firebase-functions/v2/https';
import { fetchPage } from './fetch-page.js';

export const fetchRecipe = onRequest({ region: 'us-central1', memory: '256MiB', timeoutSeconds: 30, maxInstances: 3 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    res.json(await fetchPage(String(url)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Fetch failed' });
  }
});
