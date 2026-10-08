// Deterministic platform asset compilation from the repository's SVG artwork.
// Apple applies its own icon mask and requires an opaque RGB PNG. Desktop and
// Android masters remain unchanged. Run after the root package's npm ci.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../../', import.meta.url);
const template = await readFile(new URL('assets/icon.svg', root), 'utf8');
const mark = await readFile(new URL('assets/connectwallet-mark.png', root));
assert.equal((template.match(/href="connectwallet-mark\.png"/g) ?? []).length, 1);
const source = template.replace('href="connectwallet-mark.png"', `href="data:image/png;base64,${mark.toString('base64')}"`)
  .replace(/(<svg\b[^>]*>)/, '$1<rect width="512" height="512" fill="#0d1024"/>');
const rendered = new Resvg(source, { fitTo: { mode: 'width', value: 1024 }, font: { loadSystemFonts: false } }).render();
assert.equal(rendered.width, 1024); assert.equal(rendered.height, 1024);
const pixels = rendered.pixels, scanlines = Buffer.alloc(1024 * (1 + 1024 * 3));
for (let y = 0; y < 1024; y++) {
  for (let x = 0; x < 1024; x++) {
    const source = (y * 1024 + x) * 4, target = y * (1 + 1024 * 3) + 1 + x * 3;
    assert.equal(pixels[source + 3], 255, 'iOS icon must be fully opaque');
    scanlines[target] = pixels[source]; scanlines[target + 1] = pixels[source + 1]; scanlines[target + 2] = pixels[source + 2];
  }
}
function chunk(name, data) {
  const type = Buffer.from(name), body = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const value of body) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1024, 0); header.writeUInt32BE(1024, 4); header[8] = 8; header[9] = 2; // RGB, no alpha channel.
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
await writeFile(new URL('mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', root), png);
console.log('Compiled opaque 1024×1024 RGB iOS icon from existing ConnectWallet SVG.');
