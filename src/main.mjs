import { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard, powerMonitor, nativeTheme } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFile, chmod, constants, realpath } from 'node:fs/promises';
import { WalletService } from './core/wallet-service.mjs';
import { selectProfileDirectory } from './core/profile-paths.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const INDEX = join(ROOT, 'ui', 'index.html');
const UI_URL = pathToFileURL(INDEX).href;
const ICON = join(ROOT, '..', 'assets', 'icon.png');
const ICON_URL = pathToFileURL(ICON).href;
const SERVICE_METHODS = new Set(['getState','prepareWallet','confirmWallet','cancelSetup','beginWalletReplacement','cancelWalletReplacement','restoreWallet','unlock','lock','previewSend','cancelSendPreview','confirmSend','newAddress','getRecoveryPhrase','saveConfig','setTheme','setDeveloperMode','setClaims','refresh']);
const EXTERNAL = new Set(['https://connectcoincrypto.com/','https://connectcoincrypto.com/whitepaper.pdf','https://explorer.connectcoincrypto.com/','https://github.com/connectcoincrypto/connectcoin-connect-wallet','https://github.com/connectcoincrypto/connectcoin','https://discord.gg/JYWbz5PsPp']);
let window, service, quitting = false, closing = false, actionInProgress = false, closeSequence = 0;
const themeBackground = () => nativeTheme.shouldUseDarkColors ? '#17151e' : '#f7f6f2';
function applyTheme(theme) {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  if (window && !window.isDestroyed()) window.setBackgroundColor(themeBackground());
}

async function flushWindowPreferences() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return true;
  const requestId = ++closeSequence;
  return new Promise(resolve => {
    const finish = saved => { clearTimeout(timer); ipcMain.removeListener('connectwallet:close-ready', listener); resolve(saved); };
    const listener = (event, reply) => {
      if (event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === UI_URL && reply?.requestId === requestId) finish(reply.saved === true);
    };
    const timer = setTimeout(() => finish(false), 5000);
    ipcMain.on('connectwallet:close-ready', listener);
    window.webContents.send('connectwallet:before-close', requestId);
  });
}

async function quitAfterSavingPreferences() {
  try {
    while (!await flushWindowPreferences()) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Settings have not finished saving',
        message: 'Your latest settings could not be saved before closing.',
        detail: 'Retry saving, keep the wallet open, or quit and discard any unsaved settings.',
        buttons: ['Retry saving', 'Keep wallet open', 'Quit without saving'], defaultId: 0, cancelId: 1,
      });
      if (response === 1) return;
      if (response === 2) break;
    }
    quitting = true;
    try { await service?.close(); } finally { app.exit(0); }
  } finally { closing = false; }
}

// Development UI tests use isolated temporary profiles; installed builds ignore this override.
let profileError;
try {
  app.setPath('userData', !app.isPackaged && process.env.CONNECTWALLET_TEST_PROFILE
    ? resolve(process.env.CONNECTWALLET_TEST_PROFILE)
    : selectProfileDirectory(app.getPath('appData')));
} catch (error) { profileError = error; }
app.setName('ConnectWallet');
if (profileError) {
  void app.whenReady().then(() => {
    dialog.showErrorBox('ConnectWallet could not start', 'The wallet data folder could not be read safely. Check its permissions and keep any existing wallet files intact.');
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (!closing) { closing = true; void quitAfterSavingPreferences(); }
  });
  app.on('window-all-closed', () => app.quit());
  // Do not top-level-await readiness: Electron waits for ESM evaluation first.
  void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    service = new WalletService({ directory: app.getPath('userData'), resourcesPath: process.resourcesPath });
    await service.initialize();
    // Set the saved override before the first paint; 'system' follows OS changes
    // through Chromium's prefers-color-scheme without changing the OS setting.
    applyTheme(service.config.theme);
    window = new BrowserWindow({
      width: 1380, height: 940, minWidth: 1000, minHeight: 700, show: false,
      icon: ICON,
      title: 'ConnectWallet', backgroundColor: themeBackground(),
      webPreferences: {
        preload: join(ROOT, 'preload.cjs'), nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, spellcheck: false, devTools: !app.isPackaged,
        partition: 'connectwallet-ui', navigateOnDragDrop: false,
      },
    });
    // Keep the renderer alive until its valid preference drafts reach disk.
    window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === ICON_URL || details.url.startsWith(pathToFileURL(join(ROOT,'ui')).href + '/') || details.url.startsWith('data:image/');
      callback({ cancel: !allowed });
    });
    service.on('state', state => {
      applyTheme(state.config.theme);
      if (window && !window.isDestroyed()) window.webContents.send('connectwallet:state',state);
    });
    nativeTheme.on('updated', () => {
      if (window && !window.isDestroyed()) window.setBackgroundColor(themeBackground());
    });
    powerMonitor.on('suspend', () => { void service.lock(); });
    powerMonitor.on('lock-screen', () => { void service.lock(); });
    ipcMain.on('connectwallet:activity', event => {
      if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === UI_URL) service.activity();
    });
    ipcMain.handle('connectwallet:action', async (event,method,payload) => {
      try {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== UI_URL) throw new Error('Untrusted wallet window.');
        if (typeof method !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > 16384) throw new Error('Invalid wallet action.');
        if (method === 'getState') return { ok:true,value:service.getState() };
        // Lock and review cancellation can interrupt pending work; other
        // mutations remain serialized (in particular, no parallel broadcasts).
        if (method === 'lock') return { ok:true,value:await service.lock() };
        if (method === 'cancelSendPreview') return { ok:true,value:service.cancelSendPreview() };
        if (actionInProgress) throw new Error('Another wallet action is in progress. Please wait.');
        actionInProgress = true; service.activity();
        try {
          let value;
          if (SERVICE_METHODS.has(method)) value = await service[method](payload);
          else if (method === 'copyAddress') {
            service.assertSession(); const address = service.getState().wallet.address;
            if (!address) throw new Error('No receive address is available.');
            clipboard.writeText(address); value = { copied:true };
          } else if (method === 'openDiagnostics') {
            service.assertSession();
            if (!service.config.developerMode) throw new Error('Enable Developer Mode to open diagnostic logs.');
            // Fixed application-owned directory; never accept a renderer path.
            const error = await shell.openPath(join(app.getPath('userData'), 'logs'));
            if (error) throw new Error('Could not open the local diagnostic log folder.');
            value = { opened: true };
          } else if (method === 'openExternal') {
            const url = new URL(payload.url).href;
            const explorer = new URL(url);
            const allowedTransaction = explorer.origin === 'https://explorer.connectcoincrypto.com' && /^\/tx\/[0-9a-f]{64}\/?$/.test(explorer.pathname) && !explorer.search && !explorer.hash;
            if (!EXTERNAL.has(url) && !allowedTransaction) throw new Error('This external link is not allowed.');
            await shell.openExternal(url); value = { opened:true };
          } else if (method === 'exportWallet') {
            service.assertSession();
            const selection = await dialog.showSaveDialog(window,{ title:'Save encrypted wallet backup',defaultPath:'connectwallet-backup.json',filters:[{name:'Encrypted wallet',extensions:['json']}] });
            if (selection.canceled || !selection.filePath) value = { cancelled:true };
            else {
              if (await realpath(selection.filePath).catch(()=>selection.filePath) === await realpath(service.vaultFile)) throw new Error('Choose a different file for your backup.');
              await service.persisting;
              await copyFile(service.vaultFile,selection.filePath,constants.COPYFILE_EXCL);
              await chmod(selection.filePath,0o600); value = { saved:true };
            }
          } else throw new Error('Unsupported wallet action.');
          return { ok:true,value };
        } finally { actionInProgress = false; }
      } catch(error) {
        // Do not serialize stacks, config files, process environments, or secrets.
        return { ok:false,error:String(error.message ?? 'Wallet action failed.').slice(0,500) };
      }
    });
    window.once('ready-to-show', () => { window.show(); });
    await window.loadFile(INDEX);
  } catch (error) {
    dialog.showErrorBox('ConnectWallet could not start', 'Check the configuration file in your ConnectWallet data folder. The wallet has not sent any transaction.');
    app.quit();
  }
  });
}
