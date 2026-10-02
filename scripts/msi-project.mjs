import { readFile, writeFile } from 'node:fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const namespace = 'http://wixtoolset.org/schemas/v4/wxs';
const appId = 'com.connectcoincrypto.connectwallet';
const buildProperty = 'CONNECTWALLET_WINDOWS_BUILD';
const buildSearch = 'ConnectWalletWindowsBuildSearch';
const registryKey = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const minimumWindows = 'Installed OR (CONNECTWALLET_WINDOWS_BUILD >= 10240)';
const minimumWindowsMessage = 'Windows 10 or later is required to install ConnectWallet.';
const originalWindows = 'Installed OR VersionNT >= 601';

function requireShape(condition, message) {
  if (!condition) throw new Error(`ConnectWallet MSI policy: ${message}`);
}

function elements(parent, name) {
  return Array.from(parent.getElementsByTagNameNS(namespace, name));
}

function one(parent, name, predicate = () => true) {
  const matches = elements(parent, name).filter(predicate);
  requireShape(matches.length === 1, `expected exactly one ${name}; found ${matches.length}.`);
  return matches[0];
}

function byId(parent, name, id) {
  return one(parent, name, node => node.getAttribute('Id') === id);
}

function expectAttributes(node, expected) {
  for (const [key, value] of Object.entries(expected)) {
    requireShape(node.getAttribute(key) === value, `${node.tagName}.${key} must be ${JSON.stringify(value)}.`);
  }
}

function createElement(document, name, attributes) {
  const node = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** Validate the pinned electron-builder manifest before changing installer policy. */
export function applyMsiPolicy(xml) {
  requireShape(typeof xml === 'string' && !/<!DOCTYPE|<!ENTITY/i.test(xml), 'DTD/entity declarations are not supported.');
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: message => errors.push(message),
      error: message => errors.push(message),
      fatalError: message => errors.push(message),
    },
  }).parseFromString(xml, 'application/xml');
  requireShape(errors.length === 0, `invalid XML: ${errors.join('; ')}`);
  const root = document.documentElement;
  requireShape(root?.localName === 'Wix' && root.namespaceURI === namespace, 'unexpected WiX root/namespace; review the electron-builder template.');
  // Namespace-aware creation below preserves the builder's namespace without
  // introducing xmlns="" or a second, incompatible WiX namespace.
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    requireShape(element.namespaceURI === namespace, `unexpected namespace on ${element.tagName}.`);
  }
  const product = one(root, 'Product');
  requireShape(product.parentNode === root, 'Product must be a direct child of Wix.');
  expectAttributes(product, { Name: 'ConnectWallet', Codepage: '65001' });
  requireShape(/^\d+$/.test(product.getAttribute('Language')), 'Product.Language must be explicit.');
  const uiRef = one(product, 'UIRef');
  expectAttributes(uiRef, { Id: 'WixUI_InstallDir' });
  const packageNode = one(product, 'Package');
  requireShape(packageNode.parentNode === product, 'Package must be a direct child of Product.');
  expectAttributes(packageNode, { Compressed: 'yes', InstallerVersion: '500' });
  requireShape(elements(product, 'CustomAction').every(node => node.getAttribute('Id') !== 'runAfterFinish'), 'runAfterFinish must be disabled.');

  const icon = one(product, 'Icon');
  expectAttributes(icon, { Id: 'ConnectWalletIcon.exe' });
  requireShape(/(?:^|[\\/])icon\.ico$/i.test(icon.getAttribute('SourceFile')), 'installer icon must use assets/icon.ico.');
  const arp = byId(product, 'Property', 'ARPPRODUCTICON');
  expectAttributes(arp, { Value: icon.getAttribute('Id') });

  const main = byId(product, 'File', 'mainExecutable');
  expectAttributes(main, { Name: 'ConnectWallet.exe', KeyPath: 'yes' });
  const helper = one(product, 'File', node => node.getAttribute('Name') === 'connectwallet-claims.exe');
  requireShape(/[\\/]resources[\\/]claims-helper[\\/]connectwallet-claims\.exe$/.test(helper.getAttribute('Source')), 'native claims helper must be packaged in resources/claims-helper.');
  const shortcuts = elements(product, 'Shortcut');
  requireShape(shortcuts.length === 2, 'expected the desktop and Start Menu shortcuts.');
  for (const [id, directory] of [['desktopShortcut', 'DesktopFolder'], ['startMenuShortcut', 'ProgramMenuFolder']]) {
    const shortcut = byId(product, 'Shortcut', id);
    requireShape(shortcut.parentNode === main, `${id} must belong to mainExecutable.`);
    expectAttributes(shortcut, {
      Name: 'ConnectWallet', Directory: directory, WorkingDirectory: 'APPLICATIONFOLDER',
      Advertise: 'yes', Icon: icon.getAttribute('Id'),
    });
    const properties = elements(shortcut, 'ShortcutProperty');
    // electron-builder already authors the Start Menu AppUserModel.ID; validate
    // it and add the same property to its otherwise property-less desktop link.
    if (id === 'desktopShortcut' && properties.length === 0) {
      shortcut.appendChild(createElement(document, 'ShortcutProperty', { Key: 'System.AppUserModel.ID', Value: appId }));
    } else {
      requireShape(properties.length === 1, `${id} must have one AppUserModel.ID.`);
      expectAttributes(properties[0], { Key: 'System.AppUserModel.ID', Value: appId });
    }
  }

  const condition = one(product, 'Condition');
  requireShape(condition.parentNode === product, 'launch Condition must be a direct child of Product.');
  const currentCondition = condition.textContent.trim();
  const existingBuildProperties = elements(product, 'Property').filter(node => node.getAttribute('Id') === buildProperty);
  if (currentCondition === originalWindows) {
    expectAttributes(condition, { Message: 'Windows 7 and above is required' });
    requireShape(existingBuildProperties.length === 0 && !elements(product, 'RegistrySearch').some(node => node.getAttribute('Id') === buildSearch), 'Windows build search already exists unexpectedly.');
    // VersionNT reports 603 even on Windows 10. Read the real build as REG_SZ;
    // Windows 10 starts at build 10240, and Windows 11 also satisfies this check.
    // https://learn.microsoft.com/en-us/troubleshoot/windows-client/application-management/versionnt-value-for-windows-10-server
    const property = createElement(document, 'Property', { Id: buildProperty, Secure: 'yes' });
    property.appendChild(createElement(document, 'RegistrySearch', {
      Id: buildSearch, Root: 'HKLM', Key: registryKey, Name: 'CurrentBuildNumber', Type: 'raw', Win64: 'yes',
    }));
    product.insertBefore(property, condition);
    condition.textContent = minimumWindows;
    condition.setAttribute('Message', minimumWindowsMessage);
  } else {
    // Idempotent only for our exact policy; unfamiliar templates fail closed.
    requireShape(currentCondition === minimumWindows, 'unrecognized Windows launch condition; review the electron-builder template.');
    expectAttributes(condition, { Message: minimumWindowsMessage });
    const property = byId(product, 'Property', buildProperty);
    requireShape(property.parentNode === product, 'Windows build property must be a direct child of Product.');
    expectAttributes(property, { Secure: 'yes' });
    expectAttributes(one(property, 'RegistrySearch'), {
      Id: buildSearch, Root: 'HKLM', Key: registryKey, Name: 'CurrentBuildNumber', Type: 'raw', Win64: 'yes',
    });
  }
  product.setAttribute('Language', '1033');
  return new XMLSerializer().serializeToString(document);
}

// electron-builder 26 passes the generated .wxs path, not a context object.
export default async function msiProjectCreated(projectFile) {
  requireShape(typeof projectFile === 'string' && /\.wxs$/i.test(projectFile), 'hook requires a generated .wxs path.');
  const original = await readFile(projectFile, 'utf8');
  const updated = applyMsiPolicy(original);
  await writeFile(projectFile, updated, 'utf8');
}
