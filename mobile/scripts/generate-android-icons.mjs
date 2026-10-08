// Reuse committed ConnectWallet artwork only; no network or image service.
// Run from the repository root: node mobile/scripts/generate-android-icons.mjs
// --check verifies every committed bitmap without modifying files.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Resvg } = createRequire(path.join(root, 'package.json'))('@resvg/resvg-js');
const resources = path.join(root, 'mobile/android/app/src/main/res');
const check = process.argv.includes('--check');
assert(process.argv.slice(2).every((arg) => arg === '--check'), 'Only --check is supported');
const template = await readFile(path.join(root, 'assets/icon.svg'), 'utf8');
const mark = await readFile(path.join(root, 'assets/connectwallet-mark.png'));
assert.equal(mark.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.equal((template.match(/href="connectwallet-mark\.png"/g) ?? []).length, 1);
const markUri = `data:image/png;base64,${mark.toString('base64')}`;
const icon = template.replace('href="connectwallet-mark.png"', `href="${markUri}"`);
const background = '#14152f';
const svg = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
const artwork = (x, y, size) => `<image href="${markUri}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
// The master has transparent margins. Its visible mark stays inside the central
// 66dp adaptive-icon safe circle; retain that padding for every launcher mask.
const foreground = svg(108, 108, artwork(15, 15, 78));
const round = svg(48, 48, `<circle cx="24" cy="24" r="24" fill="${background}"/>${artwork(2, 2, 44)}`);
let count = 0;

async function output(relativePath, source, width, height = width) {
  const renderer = new Resvg(source, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  const rendered = renderer.render();
  assert.equal(rendered.width, width);
  assert.equal(rendered.height, height);
  const png = rendered.asPng();
  const destination = path.join(resources, relativePath);
  if (check) {
    assert.deepEqual(await readFile(destination), png, `${relativePath} differs from the official artwork; regenerate it`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, png);
  }
  count++;
}

for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
  await output(`mipmap-${density}/ic_launcher.png`, icon, 48 * scale);
  await output(`mipmap-${density}/ic_launcher_round.png`, round, 48 * scale);
  await output(`mipmap-${density}/ic_launcher_foreground.png`, foreground, 108 * scale);
}

// Replace every legacy scaffold splash as well as the adaptive launcher artwork.
// Android's SplashScreen theme uses the same generated foreground on API 24+.
for (const [directory, width, height] of [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280], ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
]) {
  const size = Math.round(Math.min(width, height) * 0.4);
  const splash = svg(width, height, `<rect width="${width}" height="${height}" fill="${background}"/>${artwork((width - size) / 2, (height - size) / 2, size)}`);
  await output(`${directory}/splash.png`, splash, width, height);
}

console.log(`${check ? 'Verified' : 'Generated'} ${count} official ConnectWallet Android bitmaps.`);
