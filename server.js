import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const splatExtensions = new Set(['.ply', '.spz', '.splat', '.ksplat']);
const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
const modes = new Set(['image', 'panorama', 'hemisphere']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(option('port', 43210));
const scenesRoot = resolve(option('scenes', join(root, 'scenes')));
const openBrowser = process.argv.includes('--open');

function inside(base, target) {
  return target === base || target.startsWith(base + sep);
}

function readMode(file) {
  try {
    const mode = JSON.parse(readFileSync(file, 'utf8')).mode;
    return modes.has(mode) ? mode : 'image';
  } catch {
    return 'image';
  }
}

function fileUrl(path) {
  return `/files/${relative(scenesRoot, path).split(sep).map(encodeURIComponent).join('/')}`;
}

async function readFolder(folder) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return { name: basename(folder), path: '', folders: [], scenes: [] };
  }
  entries = entries.filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const folders = [];
  const scenes = [];
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      const child = await readFolder(path);
      if (child.folders.length || child.scenes.length) folders.push(child);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (!splatExtensions.has(extension)) continue;
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats?.isFile()) continue;
    const stem = entry.name.slice(0, -extension.length);
    const image = imageExtensions.map((suffix) => `${stem}${suffix}`).find((name) => names.has(name.toLowerCase()));
    const imageName = image && entries.find((item) => item.name.toLowerCase() === image.toLowerCase()).name;
    const sidecar = entries.find((item) => item.name.toLowerCase() === `${stem}.json`.toLowerCase());
    scenes.push({
      id: relative(scenesRoot, path).split(sep).join('/'),
      name: stem,
      mode: sidecar ? readMode(join(folder, sidecar.name)) : 'image',
      sizeBytes: stats.size,
      plyUrl: fileUrl(path),
      fileName: entry.name,
      imageUrl: imageName ? fileUrl(join(folder, imageName)) : null,
    });
  }
  return { name: basename(folder), path: relative(scenesRoot, folder).split(sep).join('/'), folders, scenes };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendFile(response, path, cache) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    stats = null;
  }
  if (!stats?.isFile()) {
    sendJson(response, 404, { error: 'File not found' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cache,
  });
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  let path;
  try {
    path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    sendJson(response, 400, { error: 'Bad request' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  if (path === '/api/scenes') {
    sendJson(response, 200, { root: scenesRoot, exists: existsSync(scenesRoot), tree: await readFolder(scenesRoot) });
    return;
  }
  if (path.startsWith('/files/')) {
    const target = resolve(scenesRoot, `.${path.slice('/files'.length)}`);
    if (inside(scenesRoot, target)) sendFile(response, target, 'no-cache');
    else sendJson(response, 404, { error: 'File not found' });
    return;
  }
  const target = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (inside(dist, target)) sendFile(response, target, path.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-cache');
  else sendJson(response, 404, { error: 'File not found' });
});

function launchBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('The viewer is not built yet. Run the install script first.');
  process.exit(1);
}

const url = `http://127.0.0.1:${port}`;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${port} is already in use. The viewer is probably running already: ${url}`);
    if (openBrowser) launchBrowser(url);
    process.exit(0);
  }
  throw error;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Gaussian Viewer: ${url}`);
  console.log(`Scenes: ${scenesRoot}`);
  console.log('Close this window or press Ctrl+C to stop.');
  if (openBrowser) launchBrowser(url);
});
