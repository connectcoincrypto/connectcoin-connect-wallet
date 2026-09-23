const { contextBridge, ipcRenderer } = require('electron');
const METHODS = new Set(['getState','prepareWallet','confirmWallet','cancelSetup','beginWalletReplacement','cancelWalletReplacement','restoreWallet','unlock','lock','previewSend','cancelSendPreview','confirmSend','newAddress','getRecoveryPhrase','exportWallet','saveConfig','setTheme','setDeveloperMode','setClaims','refresh','openExternal','openDiagnostics','copyAddress']);
let lastActivity = 0;
for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, () => {
  const now = Date.now();
  if (now - lastActivity > 5000) { lastActivity = now; ipcRenderer.send('connectwallet:activity'); }
}, { capture: true });
contextBridge.exposeInMainWorld('connectwallet', Object.freeze({
  invoke: async (method, payload = {}) => {
    if (!METHODS.has(method)) throw new Error('Unsupported wallet action.');
    const reply = await ipcRenderer.invoke('connectwallet:action', method, payload);
    if (!reply?.ok) throw new Error(reply?.error || 'The wallet action could not be completed.');
    return reply.value;
  },
  onState: callback => {
    if (typeof callback !== 'function') throw new Error('A callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('connectwallet:state', listener);
    return () => ipcRenderer.removeListener('connectwallet:state', listener);
  },
  onBeforeClose: callback => {
    if (typeof callback !== 'function') throw new Error('A callback is required.');
    const listener = async (_event, requestId) => {
      try { await callback(); ipcRenderer.send('connectwallet:close-ready', { requestId, saved: true }); }
      catch { ipcRenderer.send('connectwallet:close-ready', { requestId, saved: false }); }
    };
    ipcRenderer.on('connectwallet:before-close', listener);
    return () => ipcRenderer.removeListener('connectwallet:before-close', listener);
  },
}));
