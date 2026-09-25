// Local dev server: serves the app and the /api/fetch endpoint. No dependencies.
//   node server.js   ->  http://localhost:5173
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPage } from './functions/fetch-page.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/fetch') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const out = await fetchPage(u.searchParams.get('url') || '');
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = e.status || 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    console.log(`fetch ${res.statusCode} ${u.searchParams.get('url')}`);
    return;
  }
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || rel.startsWith('functions') || rel.startsWith('node_modules')) { res.statusCode = 403; return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => console.log(`Recipe Planner running at http://localhost:${PORT}`));
