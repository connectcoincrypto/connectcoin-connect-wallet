import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import msiProjectCreated, { applyMsiPolicy } from '../scripts/msi-project.mjs';

const namespace = 'http://wixtoolset.org/schemas/v4/wxs';
const require = createRequire(import.meta.url);
// Initialize builder's public entry before its targets (their imports are cyclic).
require('app-builder-lib');
const { default: MsiTarget } = require('app-builder-lib/out/targets/MsiTarget.js');
const { getEffectiveOptions } = require('app-builder-lib/out/options/CommonWindowsInstallerConfiguration.js');
const { Arch } = require('builder-util');

const synthetic = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="${namespace}">
  <Product Id="*" Name="ConnectWallet" UpgradeCode="D88D5A21-77B9-537E-98D1-01560F964433" Version="0.1.0" Language="1046" Codepage="65001" Manufacturer="ConnectCoin contributors">
    <Package Compressed="yes" InstallerVersion="500"/>
    <Condition Message="Windows 7 and above is required"><![CDATA[Installed OR VersionNT >= 601]]></Condition>
    <Icon Id="ConnectWalletIcon.exe" SourceFile="C:\\wallet\\assets\\icon.ico"/>
    <Property Id="ARPPRODUCTICON" Value="ConnectWalletIcon.exe"/>
    <UIRef Id="WixUI_InstallDir"/>
    <ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">
      <Component><File Id="mainExecutable" Name="ConnectWallet.exe" Source="$(var.appDir)\\ConnectWallet.exe" ReadOnly="yes" KeyPath="yes">
        <Shortcut Id="desktopShortcut" Directory="DesktopFolder" Name="ConnectWallet" WorkingDirectory="APPLICATIONFOLDER" Advertise="yes" Icon="ConnectWalletIcon.exe"/>
        <Shortcut Id="startMenuShortcut" Directory="ProgramMenuFolder" Name="ConnectWallet" WorkingDirectory="APPLICATIONFOLDER" Advertise="yes" Icon="ConnectWalletIcon.exe">
          <ShortcutProperty Key="System.AppUserModel.ID" Value="com.connectcoincrypto.connectwallet"/>
        </Shortcut>
      </File></Component>
      <Component><File Name="connectwallet-claims.exe" Source="$(var.appDir)\\resources\\claims-helper\\connectwallet-claims.exe" ReadOnly="yes" KeyPath="yes"/></Component>
    </ComponentGroup>
  </Product>
</Wix>`;

function parse(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function all(document, tag) {
  return Array.from(document.getElementsByTagNameNS(namespace, tag));
}

test('MSI hook enforces English, a real Windows 10 check and both shortcut identities', () => {
  const updated = applyMsiPolicy(synthetic);
  const document = parse(updated);
  assert.equal(all(document, 'Product')[0].getAttribute('Language'), '1033');
  const condition = all(document, 'Condition')[0];
  assert.equal(condition.textContent, 'Installed OR (CONNECTWALLET_WINDOWS_BUILD >= 10240)');
  assert.equal(condition.getAttribute('Message'), 'Windows 10 or later is required to install ConnectWallet.');
  const search = all(document, 'RegistrySearch')[0];
  assert.equal(search.getAttribute('Name'), 'CurrentBuildNumber');
  assert.equal(search.getAttribute('Root'), 'HKLM');
  assert.equal(search.getAttribute('Win64'), 'yes');
  assert.equal(search.parentNode.getAttribute('Secure'), 'yes');
  for (const shortcut of all(document, 'Shortcut')) {
    const properties = all(shortcut, 'ShortcutProperty');
    assert.equal(properties.length, 1);
    assert.equal(properties[0].getAttribute('Key'), 'System.AppUserModel.ID');
    assert.equal(properties[0].getAttribute('Value'), 'com.connectcoincrypto.connectwallet');
  }
  assert.equal((updated.match(/xmlns=/g) ?? []).length, 1);
  assert.equal(applyMsiPolicy(updated), updated, 'reapplying policy must be idempotent');
});

test('MSI policy refuses malformed XML or unexpected builder template shapes', () => {
  const unexpected = [
    ['namespace', synthetic.replace(namespace, 'http://schemas.microsoft.com/wix/2006/wi')],
    ['malformed XML', synthetic.replace('</Product>', '</Unknown>')],
    ['DTD', synthetic.replace('<Wix', '<!DOCTYPE Wix [<!ENTITY other "injected">]><Wix')],
    ['product name', synthetic.replace('Name="ConnectWallet"', 'Name="OtherWallet"')],
    ['missing language', synthetic.replace(' Language="1046"', '')],
    ['UI reference', synthetic.replace('WixUI_InstallDir', 'WixUI_Minimal')],
    ['condition', synthetic.replace('VersionNT >= 601', 'VersionNT >= 1000')],
    ['missing condition', synthetic.replace(/\s*<Condition[^]*?<\/Condition>/, '')],
    ['duplicate condition', synthetic.replace('</Product>', '<Condition Message="Other">1</Condition></Product>')],
    ['icon mapping', synthetic.replace('Id="ARPPRODUCTICON" Value="ConnectWalletIcon.exe"', 'Id="ARPPRODUCTICON" Value="Missing.exe"')],
    ['wrong icon', synthetic.replace('assets\\icon.ico', 'assets\\other.ico')],
    ['missing desktop shortcut', synthetic.replace(/\s*<Shortcut Id="desktopShortcut"[^>]*\/>/, '')],
    ['wrong appID', synthetic.replace('com.connectcoincrypto.connectwallet', 'com.example.other')],
    ['wrong helper location', synthetic.replace('resources\\claims-helper\\', 'resources\\elsewhere\\')],
    ['automatic launch', synthetic.replace('</Product>', '<CustomAction Id="runAfterFinish"/></Product>')],
  ];
  for (const [name, xml] of unexpected) {
    assert.throws(() => applyMsiPolicy(xml), /ConnectWallet MSI policy:/, name);
  }
  const enforced = applyMsiPolicy(synthetic);
  assert.throws(() => applyMsiPolicy(enforced.replace('CurrentBuildNumber', 'CurrentVersion')), /CurrentBuildNumber/);
  assert.throws(() => applyMsiPolicy(enforced.replace('Win64="yes"', 'Win64="no"')), /Win64/);
});

test('hook accepts electron-builder path and preserves an invalid input file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-msi-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'project.wxs');
  await writeFile(path, synthetic);
  await msiProjectCreated(path);
  assert.equal(await readFile(path, 'utf8'), applyMsiPolicy(synthetic));
  const invalid = synthetic.replace('Name="ConnectWallet"', 'Name="Unknown"');
  await writeFile(path, invalid);
  await assert.rejects(msiProjectCreated(path), /ConnectWallet MSI policy:/);
  assert.equal(await readFile(path, 'utf8'), invalid);
  await assert.rejects(msiProjectCreated({ projectFile: path }), /generated \.wxs path/);
});

test('pinned electron-builder generated manifest remains compatible with MSI policy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-msi-builder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'resources', 'claims-helper'), { recursive: true });
  await writeFile(join(directory, 'ConnectWallet.exe'), 'test executable');
  await writeFile(join(directory, 'resources', 'claims-helper', 'connectwallet-claims.exe'), 'test helper');
  const packager = {
    config: { msi: { oneClick: false, perMachine: false, runAfterFinish: false } },
    platformSpecificBuildOptions: {}, compression: 'normal', fileAssociations: [],
    appInfo: {
      productName: 'ConnectWallet', productFilename: 'ConnectWallet', sanitizedProductName: 'ConnectWallet',
      sanitizedName: 'ConnectWallet', id: 'com.connectcoincrypto.connectwallet', companyName: 'ConnectCoin contributors',
      description: 'ConnectWallet', getVersionInWeirdWindowsForm: () => '0.1.0',
    },
    getIconPath: async () => fileURLToPath(new URL('../assets/icon.ico', import.meta.url)),
  };
  const target = new MsiTarget(packager, directory);
  const common = getEffectiveOptions(target.options, packager);
  const manifest = await target.writeManifest(directory, Arch.x64, common);
  assert.match(manifest, /Windows 7 and above is required/);
  const result = applyMsiPolicy(manifest);
  assert.match(result, /Language="1033"/);
  assert.match(result, /CurrentBuildNumber/);
  assert.doesNotMatch(result, /Windows 7/);
  assert.equal(all(parse(result), 'ShortcutProperty').length, 2);
});
