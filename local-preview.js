// Local preview only. Data in local-data is never served as static files.
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './server.js';

const root = path.resolve('local-data');
function file(key) {
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return resolved;
}
const storage = {
  async put(key, body) { const target = file(key); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body); },
  async get(key) { try { return await readFile(file(key)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
  async delete(key) { await rm(file(key), { force: true }); },
  async list(prefix) {
    const results = [];
    async function walk(dir) {
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) { const target = path.join(dir, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.isFile()) results.push(path.relative(root, target).split(path.sep).join('/')); }
    }
    await walk(root); return results.filter(key => key.startsWith(prefix));
  },
};
await mkdir(root, { recursive: true });
const seeds = [
  { id: 'cf27ab2f-27a7-4afe-b920-d99cc4011001', title: 'Frontend Developer', location: 'Navi Mumbai / Hybrid', type: 'Full-time', description: 'Build thoughtful, responsive interfaces for products that help growing businesses work better. Experience with JavaScript, HTML and CSS is welcome.', open: true, createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'cf27ab2f-27a7-4afe-b920-d99cc4011002', title: 'Business Development Executive', location: 'Navi Mumbai', type: 'Full-time', description: 'Connect with businesses, understand their needs and introduce them to Srijan Labs products. Strong communication and a curiosity about technology are valuable.', open: true, createdAt: '2026-01-01T00:00:00.000Z' },
];
// Seed only on first setup, so deleted or edited sample roles stay that way.
if (!(await storage.get('.initialized'))) {
  for (const role of seeds) await storage.put(`positions/${role.id}.json`, JSON.stringify(role));
  await storage.put('.initialized', 'local preview initialized');
}
const port = Number(process.env.LOCAL_PORT || 3002);
const env = { NODE_ENV: 'development', ADMIN_PASSWORD: process.env.LOCAL_ADMIN_PASSWORD || 'local-preview-123', SITE_URL: `http://localhost:${port}` };
createApp({ env, storage }).listen(port, '127.0.0.1', () => console.log(`Local preview: http://localhost:${port}/apply`));
