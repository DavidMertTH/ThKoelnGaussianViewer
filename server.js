import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const settingsFile = join(root, 'settings.json');
const splatExtensions = new Set(['.ply', '.spz', '.splat', '.ksplat']);
const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
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

function savedFolder() {
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8')).scenes;
  } catch {
    return null;
  }
}

const port = Number(option('port', 43210));
let scenesRoot = resolve(option('scenes', savedFolder() || join(root, 'scenes')));
const openBrowser = process.argv.includes('--open');
const dialogTitle = 'Choose scene folder';
const windowsDialog = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${dialogTitle}'
$dialog.SelectedPath = $env:VIEWER_FOLDER
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
if ($dialog.ShowDialog($owner) -eq 'OK') { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)) }
`;
const macDialog = [
  'on run argv',
  'activate',
  `return POSIX path of (choose folder with prompt "${dialogTitle}" default location (POSIX file (item 1 of argv)))`,
  'end run',
];
let pendingDialog = null;

function inside(base, target) {
  return target === base || target.startsWith(base + sep);
}

async function folderDialog() {
  const start = existsSync(scenesRoot) ? scenesRoot : homedir();
  const commands = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(windowsDialog, 'utf16le').toString('base64')]]]
    : process.platform === 'darwin'
      ? [['osascript', [...macDialog.flatMap((line) => ['-e', line]), start]]]
      : [['zenity', ['--file-selection', '--directory', `--title=${dialogTitle}`, `--filename=${join(start, sep)}`]],
        ['kdialog', ['--getexistingdirectory', start, '--title', dialogTitle]]];
  for (const [command, args] of commands) {
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(command, args, { env: { ...process.env, VIEWER_FOLDER: start } }));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return null;
    }
    const folder = process.platform === 'win32' ? Buffer.from(stdout, 'base64').toString('utf8') : stdout.replace(/\r?\n$/, '');
    return folder || null;
  }
  throw new Error('No folder dialog found. Install zenity or start the viewer with --scenes /path/to/scenes.');
}

function chooseFolder() {
  pendingDialog ??= folderDialog().finally(() => { pendingDialog = null; });
  return pendingDialog;
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
    scenes.push({
      id: relative(scenesRoot, path).split(sep).join('/'),
      name: stem,
      sizeBytes: stats.size,
      plyUrl: fileUrl(path),
      fileName: entry.name,
      imageUrl: imageName ? fileUrl(join(folder, imageName)) : null,
    });
  }
  return { name: basename(folder), path: relative(scenesRoot, folder).split(sep).join('/'), folders, scenes };
}

async function readLibrary() {
  return { root: scenesRoot, exists: existsSync(scenesRoot), tree: await readFolder(scenesRoot) };
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
  if (path === '/api/folder' && request.method === 'POST') {
    let folder;
    try {
      folder = await chooseFolder();
    } catch (error) {
      sendJson(response, 500, { error: error.message });
      return;
    }
    if (folder) {
      scenesRoot = resolve(folder);
      try {
        writeFileSync(settingsFile, JSON.stringify({ scenes: scenesRoot }, null, 2));
      } catch {}
    }
    sendJson(response, 200, { ...(await readLibrary()), changed: !!folder });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  if (path === '/api/scenes') {
    sendJson(response, 200, await readLibrary());
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
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
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
