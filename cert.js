import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const day = 24 * 60 * 60 * 1000;

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const length = [];
  for (let size = body.length; size > 0; size = Math.floor(size / 256)) length.unshift(size % 256);
  const header = body.length < 0x80 ? [tag, body.length] : [tag, 0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from(header), body]);
}

const sequence = (...parts) => der(0x30, ...parts);

function oid(text) {
  const [first, second, ...rest] = text.split('.').map(Number);
  const bytes = [40 * first + second];
  for (let value of rest) {
    const chunk = [value & 0x7f];
    while ((value >>= 7) > 0) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date) {
  return der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
}

// Self-signed ECDSA certificate for localhost and the given IPv4 addresses.
function createCertificate(addresses) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from('Gaussian Viewer')))));
  const altNames = [der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])),
    ...addresses.map((address) => der(0x87, Buffer.from(address.split('.').map(Number))))];
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    sequence(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + 825 * day))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('2.5.29.17'), der(0x04, sequence(...altNames))),
      sequence(oid('2.5.29.37'), der(0x04, sequence(oid('1.3.6.1.5.5.7.3.1')))),
    )),
  );
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// Reuses the stored certificate so headsets only have to accept it once.
export function loadCertificate(folder, addresses) {
  const certFile = join(folder, 'cert.pem');
  const keyFile = join(folder, 'key.pem');
  try {
    const stored = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
    if (new Date(new X509Certificate(stored.cert).validTo).getTime() > Date.now() + day) return stored;
  } catch {}
  const created = createCertificate(addresses);
  mkdirSync(folder, { recursive: true });
  writeFileSync(certFile, created.cert);
  writeFileSync(keyFile, created.key, { mode: 0o600 });
  return created;
}
