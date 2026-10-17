#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg'
};
export async function createPreviewServer(directory) {
  const root=path.resolve(directory);
  const report=await fs.readFile(path.join(root,'report.json'),'utf8').then(JSON.parse).catch(()=>null);
  const initialPaths=new Set(['/']);
  for (const route of [report?.inputUrl,report?.finalUrl]) {
    if (route) {try {initialPaths.add(new URL(route,'http://localhost').pathname);} catch {}}
  }
  return http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const assetOffset=pathname.lastIndexOf('/assets/');
    const relative=initialPaths.has(pathname) ? '/index.html' : assetOffset>=0 ? pathname.slice(assetOffset) : pathname;
    const file = path.resolve(root, '.' + relative);
    if (!(file === root || file.startsWith(root + path.sep))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server=await createPreviewServer(process.argv[2] || 'output');
  server.listen(Number(process.argv[3] || 4173),'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${server.address().port}`));
}
