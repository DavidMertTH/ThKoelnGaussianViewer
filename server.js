import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadCertificate } from './cert.js';
import { firewallActive, startHotspot } from './hotspot.js';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const settingsFile = join(root, 'settings.json');
const thumbnails = join(root, 'thumbnails');
const maxThumbnailBytes = 1 << 20;
// Ratings stay with the viewer on each computer: this computer's own, and the files imported from the
// others, each under the name of the person who rated, given when it is imported.
const ratingsFolder = join(root, 'ratings');
const ownRatingsFile = join(ratingsFolder, 'mine.json');
const importedRatingsFile = join(ratingsFolder, 'imported.json');
const ratingsFormat = 'gaussian-viewer-ratings';
const maxStars = 5;
const maxComment = 5000;
const maxRatingsImport = 10 << 20;
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
const lanPort = Number(option('lan-port', port + 1));
let scenesRoot = resolve(option('scenes', savedFolder() || join(root, 'scenes')));
const openBrowser = process.argv.includes('--open');
// Headsets on the network are served by default; --no-lan keeps the viewer to this computer.
const lan = !process.argv.includes('--no-lan');
// On Linux --hotspot opens a Wi-Fi hotspot for the headsets; without it the Wi-Fi stays as it is.
const hotspot = lan && process.argv.includes('--hotspot');
// Shows frame-rate displays in the viewer, on screen and in VR.
const debug = process.argv.includes('--debug');
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

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function fromThisComputer(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
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

// The key changes when the splat file changes, so an old thumbnail is never shown for a new scene.
function thumbnailName(path, stats) {
  return `${createHash('sha1').update(`${path}\n${stats.size}\n${stats.mtimeMs}`).digest('hex')}.jpg`;
}

function sceneFile(id) {
  const path = resolve(scenesRoot, id);
  const stats = statSync(path, { throwIfNoEntry: false });
  return inside(scenesRoot, path) && splatExtensions.has(extname(path).toLowerCase()) && stats?.isFile() ? { path, stats } : null;
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function readJson(path, fallback) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// { stars: 0 to 5, or null when not given; comment; distance: the factor the slider shows, or null; updatedAt },
// or null when the value is no rating or holds nothing.
function cleanRating(value) {
  if (!isObject(value)) return null;
  const stars = Number.isInteger(value.stars) && value.stars >= 0 && value.stars <= maxStars ? value.stars : null;
  const comment = typeof value.comment === 'string' ? value.comment.slice(0, maxComment) : '';
  const distance = Number.isFinite(value.distance) && value.distance > 0 && value.distance < 100
    ? Math.round(value.distance * 100) / 100 : null;
  if (stars === null && !comment.trim() && distance === null) return null;
  return { stars, comment, distance, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now() };
}

// Scene id → rating, leaving out whatever is not one.
function cleanRatings(ratings) {
  const clean = {};
  if (!isObject(ratings)) return clean;
  for (const [id, value] of Object.entries(ratings)) {
    const rating = cleanRating(value);
    if (id && rating) clean[id] = rating;
  }
  return clean;
}

const readOwnRatings = () => cleanRatings(readJson(ownRatingsFile, {}));

// Name → { importedAt, computer, ratings }.
function readImportedRatings() {
  const imported = {};
  for (const [name, entry] of Object.entries(readJson(importedRatingsFile, {}))) {
    if (isObject(entry)) imported[name] = { importedAt: entry.importedAt ?? 0, computer: entry.computer ?? '', ratings: cleanRatings(entry.ratings) };
  }
  return imported;
}

async function readJsonBody(request, limit) {
  try {
    return JSON.parse((await readBody(request, limit)).toString('utf8'));
  } catch {
    return null;
  }
}

function readBody(request, limit) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on('end', () => (size > limit ? fail(new Error('The upload is too large.')) : done(Buffer.concat(chunks))));
    request.on('error', fail);
  });
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
    const thumbnail = thumbnailName(path, stats);
    const id = relative(scenesRoot, path).split(sep).join('/');
    scenes.push({
      id,
      name: stem,
      sizeBytes: stats.size,
      // When the file arrived in the folder, for sorting by newest: copying or moving it in sets ctime.
      addedAt: Math.round(Math.max(stats.birthtimeMs || 0, stats.ctimeMs)),
      plyUrl: fileUrl(path),
      fileName: entry.name,
      imageUrl: imageName ? fileUrl(join(folder, imageName)) : null,
      thumbUrl: existsSync(join(thumbnails, thumbnail)) ? `/thumbnails/${thumbnail}` : null,
    });
  }
  return { name: basename(folder), path: relative(scenesRoot, folder).split(sep).join('/'), folders, scenes };
}

async function readLibrary(request) {
  return {
    root: scenesRoot,
    exists: existsSync(scenesRoot),
    canChooseFolder: fromThisComputer(request),
    debug,
    tree: await readFolder(scenesRoot),
  };
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

async function handleRequest(request, response) {
  let path;
  try {
    path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    sendJson(response, 400, { error: 'Bad request' });
    return;
  }
  if (path === '/api/folder' && request.method === 'POST') {
    if (!fromThisComputer(request)) {
      sendJson(response, 403, { error: 'The scene folder can only be changed on the computer running the viewer.' });
      return;
    }
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
    sendJson(response, 200, { ...(await readLibrary(request)), changed: !!folder });
    return;
  }
  if (path === '/api/thumbnail' && request.method === 'POST') {
    const scene = sceneFile(new URL(request.url, 'http://localhost').searchParams.get('scene') || '');
    if (!scene) {
      sendJson(response, 404, { error: 'Scene not found' });
      return;
    }
    let image;
    try {
      image = await readBody(request, maxThumbnailBytes);
    } catch (error) {
      sendJson(response, 413, { error: error.message });
      return;
    }
    if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
      sendJson(response, 415, { error: 'Thumbnails must be JPEG images.' });
      return;
    }
    const name = thumbnailName(scene.path, scene.stats);
    try {
      mkdirSync(thumbnails, { recursive: true });
      writeFileSync(join(thumbnails, name), image);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
      return;
    }
    sendJson(response, 200, { thumbUrl: `/thumbnails/${name}` });
    return;
  }
  if (path.startsWith('/api/ratings')) {
    await handleRatings(path, request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  if (path === '/api/scenes') {
    sendJson(response, 200, await readLibrary(request));
    return;
  }
  if (path.startsWith('/files/')) {
    const target = resolve(scenesRoot, `.${path.slice('/files'.length)}`);
    if (inside(scenesRoot, target)) sendFile(response, target, 'no-cache');
    else sendJson(response, 404, { error: 'File not found' });
    return;
  }
  if (path.startsWith('/thumbnails/')) {
    const target = resolve(thumbnails, `.${path.slice('/thumbnails'.length)}`);
    if (inside(thumbnails, target)) sendFile(response, target, 'max-age=31536000, immutable');
    else sendJson(response, 404, { error: 'File not found' });
    return;
  }
  const target = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (inside(dist, target)) sendFile(response, target, path.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-cache');
  else sendJson(response, 404, { error: 'File not found' });
}

// GET /api/ratings: this computer's ratings and the imported ones.
// POST /api/ratings?scene=id, body a rating: this computer's rating of the scene; one with nothing in it clears it.
// GET /api/ratings/export: this computer's ratings as a file, for importing on another one.
// POST /api/ratings/import, body { name, file }: keeps the ratings of an exported file under the rater's name,
// in place of earlier ones under that name. POST /api/ratings/remove, body { name }: drops them again.
// Rating is open to the network like the scenes; importing only works on the computer running the viewer.
async function handleRatings(path, request, response) {
  const local = fromThisComputer(request);
  try {
    if (path === '/api/ratings' && request.method === 'GET') {
      const imported = Object.entries(readImportedRatings()).map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      sendJson(response, 200, { mine: readOwnRatings(), imported, canImport: local });
    } else if (path === '/api/ratings' && request.method === 'POST') {
      const id = new URL(request.url, 'http://localhost').searchParams.get('scene') || '';
      if (!sceneFile(id)) {
        sendJson(response, 404, { error: 'Scene not found' });
        return;
      }
      const body = await readJsonBody(request, 64 * 1024);
      if (!isObject(body)) {
        sendJson(response, 400, { error: 'The rating could not be read.' });
        return;
      }
      const rating = cleanRating(body);
      const ratings = readOwnRatings();
      if (rating) ratings[id] = rating;
      else delete ratings[id];
      writeJson(ownRatingsFile, ratings);
      sendJson(response, 200, { rating });
    } else if (path === '/api/ratings/export' && request.method === 'GET') {
      const exportedAt = new Date();
      const computer = hostname();
      const body = JSON.stringify({ format: ratingsFormat, version: 1, computer, exportedAt: exportedAt.toISOString(), ratings: readOwnRatings() }, null, 2);
      const stamp = exportedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': `attachment; filename="ratings-${computer.replace(/[^\w-]+/g, '_')}-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } else if ((path === '/api/ratings/import' || path === '/api/ratings/remove') && request.method === 'POST') {
      if (!local) {
        sendJson(response, 403, { error: 'Ratings can only be imported on the computer running the viewer.' });
        return;
      }
      const body = await readJsonBody(request, maxRatingsImport);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) {
        sendJson(response, 400, { error: 'Give the name of the person who rated.' });
        return;
      }
      const imported = readImportedRatings();
      if (path === '/api/ratings/remove') {
        delete imported[name];
      } else {
        const { file } = body;
        if (!isObject(file) || file.format !== ratingsFormat || !isObject(file.ratings)) {
          sendJson(response, 400, { error: 'This is not a ratings file exported from the viewer.' });
          return;
        }
        imported[name] = { importedAt: Date.now(), computer: typeof file.computer === 'string' ? file.computer : '', ratings: cleanRatings(file.ratings) };
      }
      writeJson(importedRatingsFile, imported);
      sendJson(response, 200, { name, count: Object.keys(imported[name]?.ratings ?? {}).length });
    } else {
      sendJson(response, 405, { error: 'Method not allowed' });
    }
  } catch (error) {
    sendJson(response, 500, { error: `Could not save the ratings: ${error.message}` });
  }
}

const server = createServer(handleRequest);

// Headsets need HTTPS for WebXR, so the network gets its own port with a self-signed certificate.
function startLanServer() {
  const lanServer = createHttpsServer(loadCertificate(join(root, 'certs'), lanAddresses()), handleRequest);
  lanServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${lanPort} is already in use. Start the viewer with --lan-port <port> to use another one.`);
      process.exit(1);
    }
    throw error;
  });
  lanServer.listen(lanPort, () => {
    const addresses = lanAddresses();
    for (const address of addresses) console.log(`Headsets and other devices: https://${address}:${lanPort}`);
    if (!addresses.length) console.log(`No network found. Headsets can connect on port ${lanPort} once this computer is online.`);
    console.log('Close this window or press Ctrl+C to stop.');
  });
}

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
    if (lan) console.log('If it was not started for headsets, close it and start again.');
    if (openBrowser) launchBrowser(url);
    process.exit(0);
  }
  throw error;
});
// Only once this viewer has its port, so a second start does not touch the Wi-Fi of the running one.
async function openHotspot() {
  if (process.platform !== 'linux') return;
  console.log('Opening the Wi-Fi hotspot for headsets …');
  const opened = await startHotspot();
  if (opened.skipped) {
    console.log(`No hotspot: ${opened.skipped} Headsets can still connect through the network.`);
    return;
  }
  // Closing the window or Ctrl+C turns the hotspot off, and the Wi-Fi goes back to its network.
  process.on('exit', opened.stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
  console.log(`Hotspot "${opened.ssid}" is on${opened.password ? `, password: ${opened.password}` : ''}.`);
  if (opened.address) console.log(`Connect the headsets to it and open https://${opened.address}:${lanPort}`);
  if (firewallActive()) {
    console.log(`The firewall is on. If headsets cannot open the page, allow it once: sudo ufw allow in on ${opened.device} to any port ${lanPort} proto tcp`);
  }
}

server.listen(port, '127.0.0.1', async () => {
  console.log(`Gaussian Viewer: ${url}`);
  console.log(`Scenes: ${scenesRoot}`);
  if (debug) console.log('Debug: frame-rate displays are on.');
  if (hotspot) await openHotspot();
  if (lan) startLanServer();
  else console.log('Close this window or press Ctrl+C to stop.');
  if (openBrowser) launchBrowser(url);
});
