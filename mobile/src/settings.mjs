// Public form validation. Native code independently validates settings before
// persisting them or replacing an active connection.
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  autoLockMinutes: 0,
  rpcHost: 'connectcoin4.com',
  rpcPort: 48190,
});

function validateTheme(theme) {
  if (!['dark', 'light', 'system'].includes(theme)) throw new Error('Choose System, Light or Dark appearance.');
  return theme;
}

function integer(value, min, max, name) {
  if (typeof value === 'string' && value.length && !/[^0-9]/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value === 0 ? 0 : value;
}

function publicHostname(value) {
  const error = 'Enter a public RPC hostname, without a URL, IP address, port or path.';
  if (typeof value !== 'string') throw new Error(error);
  const host = value.trim();
  if (!host.length || host.length > 253 || /[^a-zA-Z0-9.-]/.test(host)) throw new Error(error);
  const name = host.toLowerCase();
  // Match MobileRpcClient.TcpEndpoint's public DNS policy. Native resolution
  // independently rejects unsafe addresses; this checks the entered name only.
  if (!name.includes('.') || !/[^0-9.]/.test(name) ||
      ['.localhost', '.local', '.internal'].some(suffix => name.endsWith(suffix)) ||
      name.split('.').some(label => !label.length || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error(error);
  }
  return name;
}

export function parseSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`Settings must include ${key}.`);
  }
  return {
    theme: validateTheme(input.theme),
    autoLockMinutes: integer(input.autoLockMinutes, 0, 1440, 'Auto-lock minutes'),
    rpcHost: publicHostname(input.rpcHost),
    rpcPort: integer(input.rpcPort, 1, 65535, 'RPC port'),
  };
}

export function rpcEndpoint(settings) {
  return `${settings.rpcHost}:${settings.rpcPort}`;
}

export function resolvedTheme(theme, prefersDark) {
  validateTheme(theme);
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}
