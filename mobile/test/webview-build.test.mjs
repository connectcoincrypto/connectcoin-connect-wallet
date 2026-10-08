import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import config from '../vite.config.mjs';

test('packaged JavaScript supports both declared native WebViews', async () => {
  assert.deepEqual(config.build.target, ['chrome105', 'safari15.4']);
  const project = await readFile(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(match => match[1]);
  assert.ok(targets.length > 0);
  assert.ok(targets.every(target => target === '15.4'));
});
