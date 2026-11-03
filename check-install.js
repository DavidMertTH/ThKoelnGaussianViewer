import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Tells the start scripts whether to run the installer again: exits with 1 when the packages or the
// built viewer are missing, or older than what they are made from, as after pulling an update.
// Needs nothing but Node itself, so it runs before anything is installed.
process.chdir(import.meta.dirname);

const modified = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);
const newest = (path) => {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return modified(path);
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
};

// npm writes node_modules/.package-lock.json on every install.
const installed = modified('node_modules/.package-lock.json');
const built = modified('dist/index.html');
const sources = Math.max(...['src', 'index.html', 'scenes.html', 'viewer.html', 'vite.config.js', 'package-lock.json'].map(newest));

const reason = !installed ? 'The packages are not installed yet.'
  : modified('package-lock.json') > installed ? 'The packages changed.'
    : !built ? 'The viewer is not built yet.'
      : sources > built ? 'The viewer changed.'
        : null;
if (reason) {
  console.log(`${reason} Installing …`);
  process.exit(1);
}
