import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

// Linux: a Wi-Fi hotspot from NetworkManager, opened when the viewer starts with --hotspot, so headsets connect to this
// computer directly instead of through a router. A hotspot connection that already exists is used again,
// so headsets that know it reconnect by themselves; otherwise one is made, on 5 GHz where the Wi-Fi card
// allows it. Turning it on takes the Wi-Fi card off the network it was on; NetworkManager goes back to
// that network when the viewer stops and turns the hotspot off.

const NAME = 'Gaussian Viewer Hotspot';
const SSID = 'Gaussian Viewer';
const run = promisify(execFile);

async function nmcli(...args) {
  const { stdout } = await run('nmcli', args, { timeout: 60000 });
  return stdout.trim();
}

// nmcli -t separates fields with ':' and writes a ':' inside a value as '\:'.
const fields = (line) => line.split(/(?<!\\):/).map((value) => value.replace(/\\:/g, ':'));

async function wifiDevice() {
  const devices = (await nmcli('-t', '-f', 'DEVICE,TYPE', 'device')).split('\n').map(fields);
  return devices.find(([, type]) => type === 'wifi')?.[0] ?? null;
}

// A saved Wi-Fi connection in access point mode; the viewer's own one first.
async function savedHotspot() {
  const names = (await nmcli('-t', '-f', 'NAME,TYPE', 'connection', 'show')).split('\n').map(fields)
    .filter(([, type]) => type === '802-11-wireless').map(([name]) => name)
    .sort((a, b) => (b === NAME) - (a === NAME));
  for (const name of names) {
    if ((await nmcli('-g', '802-11-wireless.mode', 'connection', 'show', name)) === 'ap') return name;
  }
  return null;
}

// Long enough for WPA2, and without letters that look alike, to type it on a headset.
function newPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(10)].map((byte) => letters[byte % letters.length]).join('');
}

async function createHotspot(device) {
  const base = ['device', 'wifi', 'hotspot', 'ifname', device, 'con-name', NAME, 'ssid', SSID, 'password', newPassword()];
  try {
    await nmcli(...base, 'band', 'a', 'channel', '36');
  } catch {
    // Not every Wi-Fi card may open an access point on 5 GHz; 2.4 GHz works on all of them.
    await nmcli('connection', 'delete', NAME).catch(() => {});
    await nmcli(...base);
  }
  return NAME;
}

// Resolves to { name, ssid, password, address, stop } once the hotspot is up, or { skipped: reason }.
// stop() turns it off again, unless it was on before the viewer started; it runs synchronously, so it
// also works while the process exits.
export async function startHotspot() {
  if (process.platform !== 'linux') return { skipped: 'Hotspots are only opened on Linux.' };
  let device;
  try {
    device = await wifiDevice();
  } catch (error) {
    if (error.code === 'ENOENT') return { skipped: 'NetworkManager (nmcli) is not installed.' };
    return { skipped: `NetworkManager did not answer: ${error.message}` };
  }
  if (!device) return { skipped: 'This computer has no Wi-Fi card.' };
  try {
    let name = await savedHotspot();
    const active = (await nmcli('-t', '-f', 'NAME', 'connection', 'show', '--active')).split('\n').map((line) => fields(line)[0]);
    const wasOn = !!name && active.includes(name);
    if (!name) name = await createHotspot(device);
    else if (!wasOn) await nmcli('connection', 'up', name, 'ifname', device);
    const [ssid = '', password = ''] = (await nmcli('-s', '-g', '802-11-wireless.ssid,802-11-wireless-security.psk', 'connection', 'show', name)).split('\n');
    const address = (await nmcli('-g', 'IP4.ADDRESS', 'connection', 'show', name)).split(/[/|\n]/)[0].trim();
    let stopped = wasOn;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync('nmcli', ['connection', 'down', name], { stdio: 'ignore', timeout: 15000 });
      } catch {}
    };
    return { name, device, ssid, password, address, stop };
  } catch (error) {
    return { skipped: `The hotspot could not be opened: ${(error.stderr || error.message).trim()}` };
  }
}

// ufw keeps headsets out unless the port was allowed; checking the rules would need root.
export function firewallActive() {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'ufw'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
