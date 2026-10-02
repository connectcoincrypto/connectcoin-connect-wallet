// Build the native helper and desktop on the SAME operating system/architecture.
// This entry point never installs, launches the wallet, or publishes a release.
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const supported = { win32: ['x64'], darwin: ['x64', 'arm64'], linux: ['x64'] };

export function buildPlan(args, host = process, base = root) {
  const options = { platform: host.platform, arch: host.arch };
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(platform|arch)=([a-z0-9]+)$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('Usage: npm run dist -- [--platform=win32|darwin|linux] [--arch=x64|arm64]');
    seen.add(match[1]); options[match[1]] = match[2];
  }
  if (!supported[options.platform]?.includes(options.arch)) throw new Error('Unsupported installer platform/architecture.');
  if (options.platform !== host.platform || options.arch !== host.arch) {
    throw new Error('Native builds only: Node, Python, the claims helper and Electron must use the target OS and architecture.');
  }
  const directory = path.join(base, 'dist', 'installers', `${options.platform}-${options.arch}`);
  const flag = { win32: '--win', darwin: '--mac', linux: '--linux' }[options.platform];
  return { ...options, directory, builderArgs: [flag, `--${options.arch}`, '--publish', 'never', `--config.directories.output=${directory}`] };
}

export async function prepareOutput(directory, base = root) {
  // No deletion or reuse of old installers: mixed builds must not get a new manifest.
  // Also refuse symlink/junction parents so the builder cannot escape this checkout.
  if (path.dirname(directory) !== path.join(base, 'dist', 'installers')) throw new Error('Unexpected installer output directory.');
  const resolvedBase = await realpath(base);
  for (const current of [path.join(base, 'dist'), path.dirname(directory), directory]) {
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Unsafe output directory: ${current}`);
    if (!info) await mkdir(current);
    const relative = path.relative(resolvedBase, await realpath(current));
    if (relative !== 'dist' && !relative.startsWith(`dist${path.sep}`)) throw new Error('Output escapes the build directory.');
  }
  if ((await readdir(directory)).length) throw new Error(`Installer output is not empty. Move the previous build aside before rebuilding: ${directory}`);
}

function run(command, args, timeout = 30 * 60 * 1000) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, timeout });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`Build step failed (${code ?? signal}): ${path.basename(command)} ${args[0]}`)));
  });
}

export async function buildInstallers(args) {
  const plan = buildPlan(args);
  await prepareOutput(plan.directory);
  console.log(`Building ConnectWallet for ${plan.platform}/${plan.arch}; installer language: English; publishing: disabled.`);
  // setup-claims installs exact provider pins, runs Python regressions, bundles
  // licenses and builds PyInstaller locally. Never reuse a foreign native helper.
  await run(process.execPath, ['scripts/setup-claims.mjs', '--build']);
  await run(process.execPath, ['scripts/build-icon.mjs']);
  await run(process.execPath, ['scripts/check-package.mjs']);
  await run(process.execPath, [require.resolve('electron-builder/cli.js'), ...plan.builderArgs]);
  const verification = [`--directory=${plan.directory}`, `--platform=${plan.platform}`, `--arch=${plan.arch}`];
  await run(process.execPath, ['scripts/test-packaged.mjs', ...verification], 120000);
  if (plan.platform === 'win32') {
    const msi = (await readdir(plan.directory)).filter(name => name.endsWith('.msi'));
    if (msi.length !== 1) throw new Error('Expected exactly one MSI.');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'scripts/test-msi.ps1'), '-Path', path.join(plan.directory, msi[0])], 60000);
  }
  await run(process.execPath, ['scripts/verify-installers.mjs', ...verification], 120000);
  console.log(`Verified installers and checksums: ${plan.directory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildInstallers(process.argv.slice(2));
}
