import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLAIMS_POLICY, DEFAULT_CLAIMS_LIMITS, evaluateClaimsPolicy, parseClaimsLimits } from '../src/claims-policy.mjs';

const ready = { enabled: true, connected: true, connectionType: 'wifi', appActive: true,
  nativeClaimsAvailable: true, nativeBackgroundAvailable: false, platform: 'android' };
const denied = (patch, reason) => assert.deepEqual(evaluateClaimsPolicy({ ...ready, ...patch }), { allowed: false, reason });

test('connection ceilings default to 100 independently from boolean claims permissions', () => {
  assert.deepEqual(DEFAULT_CLAIMS_LIMITS, { connectionsPerSecondLimit: 100, concurrency: 100 });
  assert.ok(Object.isFrozen(DEFAULT_CLAIMS_LIMITS));
  assert.deepEqual(parseClaimsLimits({ connectionsPerSecondLimit: '100', concurrency: '1' }), { connectionsPerSecondLimit: 100, concurrency: 1 });
  assert.deepEqual(parseClaimsLimits({ connectionsPerSecondLimit: 2, concurrency: 99, allowBackground: true }), { connectionsPerSecondLimit: 2, concurrency: 99 });
});

test('connection ceilings reject absent, coerced, fractional and out-of-range values', () => {
  for (const value of [undefined, null, false, true, '', ' ', '1e2', '1.0', '-1', '+1', ' 1', '1 ', 'abc', 0, 101, -1, 1.1, NaN, Infinity, {}, []]) {
    assert.throws(() => parseClaimsLimits({ ...DEFAULT_CLAIMS_LIMITS, concurrency: value }), /whole numbers/);
    assert.throws(() => parseClaimsLimits({ ...DEFAULT_CLAIMS_LIMITS, connectionsPerSecondLimit: value }), /whole numbers/);
  }
  assert.throws(() => parseClaimsLimits(), /whole numbers/);
  assert.throws(() => parseClaimsLimits(null), /whole numbers/);
});

test('claims opt-ins are immutable and off by default; missing capabilities fail closed', () => {
  assert.deepEqual(DEFAULT_CLAIMS_POLICY, { allowMobileData: false, allowBackground: false });
  assert.ok(Object.isFrozen(DEFAULT_CLAIMS_POLICY));
  assert.deepEqual(evaluateClaimsPolicy(), { allowed: false, reason: 'disabled' });
  for (const unknown of [null, undefined, false, 1, 'true', []]) {
    assert.deepEqual(evaluateClaimsPolicy(unknown), { allowed: false, reason: 'disabled' });
  }
  denied({ nativeClaimsAvailable: false }, 'native-claims-unavailable');
  denied({ nativeClaimsAvailable: undefined }, 'native-claims-unavailable');
  denied({ connectionType: 'cellular' }, 'mobile-data-disabled');
  denied({ appActive: false }, 'background-disabled');
});

test('foreground claims require real native support and known connectivity on Android or iOS', () => {
  for (const platform of ['android', 'ios']) {
    for (const connectionType of ['wifi', 'ethernet']) {
      assert.deepEqual(evaluateClaimsPolicy({ ...ready, platform, connectionType }), { allowed: true, reason: 'foreground' });
    }
  }
  for (const enabled of [false, undefined, 1, 'true', null]) denied({ enabled }, 'disabled');
  for (const nativeClaimsAvailable of ['true', 1, null]) denied({ nativeClaimsAvailable }, 'native-claims-unavailable');
  for (const platform of ['web', 'windows', 'unknown', undefined]) denied({ platform }, 'unsupported-platform');
});

test('unknown or absent connection/app state is never treated as Wi-Fi or foreground', () => {
  for (const connected of [false, undefined, null, 'true', 1]) denied({ connected }, 'offline');
  for (const connectionType of ['none', 'unknown', '', undefined, '4g', {}, 'WIFI']) {
    denied({ connectionType, allowMobileData: true }, 'connection-unknown');
  }
  for (const appActive of [undefined, null, 'true', 1, 0]) denied({ appActive }, 'app-state-unknown');
});

test('mobile data requires an exact opt-in and does not grant background permission', () => {
  for (const allowMobileData of [false, undefined, 'true', 1, null]) denied({ connectionType: 'cellular', allowMobileData }, 'mobile-data-disabled');
  assert.deepEqual(evaluateClaimsPolicy({ ...ready, connectionType: 'cellular', allowMobileData: true }), { allowed: true, reason: 'foreground' });
  denied({ connectionType: 'cellular', allowMobileData: true, appActive: false }, 'background-disabled');
});

test('Android background additionally requires opt-in and an actual native background capability', () => {
  for (const allowBackground of [false, undefined, 'true', 1, null]) denied({ appActive: false, allowBackground }, 'background-disabled');
  for (const nativeBackgroundAvailable of [false, undefined, 'true', 1, null]) {
    denied({ appActive: false, allowBackground: true, nativeBackgroundAvailable }, 'native-background-unavailable');
  }
  assert.deepEqual(evaluateClaimsPolicy({ ...ready, appActive: false, allowBackground: true, nativeBackgroundAvailable: true }), { allowed: true, reason: 'background' });
  denied({ appActive: false, allowBackground: true, nativeBackgroundAvailable: true, connectionType: 'cellular' }, 'mobile-data-disabled');
});

test('iOS background is unsupported even when every preference and capability is true', () => {
  denied({ platform: 'ios', appActive: false, allowBackground: true, nativeBackgroundAvailable: true, allowMobileData: true }, 'ios-background-unsupported');
});

test('enabling every preference cannot bypass the unavailable alpha claims engine', () => {
  for (const platform of ['android', 'ios']) {
    for (const appActive of [true, false]) {
      denied({ platform, appActive, allowMobileData: true, allowBackground: true, nativeBackgroundAvailable: true,
        nativeClaimsAvailable: false }, 'native-claims-unavailable');
    }
  }
});
