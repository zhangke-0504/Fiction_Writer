import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModelProfile } from '../shared/contracts.js';
import { discoverCapabilities } from '../electron/agent/provider-capabilities.js';
import { ProfileStore } from '../electron/agent/profiles.js';

const profile: ModelProfile = {
  id: 'existing',
  name: 'DS',
  model: 'deepseek-flash',
  protocol: 'messages',
  baseUrl: 'https://api.deepseek.com/anthropic',
  providerId: 'deepseek',
};
const key = 'synthetic-auth-marker';
const cipher = 'synthetic-cipher';
const models = (id: string, context_window = 345_678, max_output_tokens = 23_456) => ({
  id,
  context_window,
  max_output_tokens,
});
const discovered = { contextWindow: 345_678, maxOutputTokens: 23_456, source: 'provider' };

test('DeepSeek discovery sends one fixed authenticated metadata request and selects the configured ID', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    return Response.json({ data: [models('other', 1000, 100), models('deepseek-flash')] });
  };
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
    assert.deepEqual(await discoverCapabilities({ ...profile, model }, key, fetcher), discovered);
  assert.equal(calls, 3);
});

test('unsupported endpoints and explicitly custom configurations never send capability credentials', async () => {
  for (const patch of [
    { baseUrl: 'https://api.deepseek.com.evil.invalid/anthropic' },
    { baseUrl: 'https://api.deepseek.com:8443/anthropic' },
    { baseUrl: 'https://api.deepseek.com' },
    { baseUrl: 'http://api.deepseek.com/anthropic' },
    { providerId: 'custom' as const },
  ]) {
    let calls = 0;
    const result = await discoverCapabilities({ ...profile, ...patch }, key, async () => {
      calls++;
      return Response.json({});
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, {
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      source: 'generic-fallback',
      issue: 'not_supported',
    });
  }
});

test('missing, ambiguous, oversized, invalid and failed metadata are bounded fallbacks', async () => {
  for (const [response, issue] of [
    [() => Response.json({ data: [] }), 'model_missing'],
    [() => Response.json({ data: [models(profile.model), models(profile.model)] }), 'invalid'],
    [() => Response.json({ data: [{ id: profile.model }] }), 'invalid'],
    [() => Response.json({ data: [models(profile.model, 5, 20)] }), 'invalid'],
    [() => new Response('x'.repeat(256 * 1024 + 1)), 'invalid'],
    [() => new Response(key, { status: 401 }), 'auth'],
    [() => Response.redirect('https://not-deepseek.invalid'), 'unavailable'],
  ] as const) {
    assert.deepEqual(await discoverCapabilities(profile, key, async () => response()), {
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      source: 'provider-fallback',
      issue,
    });
  }
  const timed = await discoverCapabilities(
    profile,
    key,
    async (_, init) => {
      await new Promise<void>((_, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('did not time out')), 1000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
      throw new Error();
    },
    5,
  );
  assert.equal(timed.issue, 'timeout');
  const unknown = await discoverCapabilities({ ...profile, model: 'unknown' }, key, async () =>
    Response.json({ data: [] }),
  );
  assert.equal(unknown.source, 'generic-fallback');
});

test('profile store persists discovery and fallback, reloads without querying and never reuses different-origin credentials for discovery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'profiles.json');
  const legacy = { ...profile, providerId: undefined, cipher };
  const gateway = { ...legacy, id: 'gateway', baseUrl: 'https://example.invalid/anthropic' };
  await writeFile(path, JSON.stringify([legacy, gateway]));
  const calls: string[] = [];
  const decrypt = async (value: string) => {
    assert.equal(value, cipher);
    return key;
  };
  const discover: typeof discoverCapabilities = (profile, key) =>
    discoverCapabilities(profile, key, async (_, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      calls.push(profile.model);
      return profile.model === 'deepseek-v4-pro'
        ? new Response(key, { status: 503 })
        : Response.json({ data: [models('deepseek-flash')] });
    });
  const store = new ProfileStore(dir, decrypt, discover);
  await store.init();
  assert.equal(store.list()[0].capabilities?.source, 'provider-fallback');
  assert.equal(store.list()[1].providerId, 'custom');
  assert.deepEqual(calls, []);
  const saved = await store.save(profile);
  assert.equal(saved.id, legacy.id);
  assert.deepEqual(saved.capabilities, discovered);
  const fromDisk = new ProfileStore(dir, decrypt, discover);
  await fromDisk.init();
  assert.deepEqual((await fromDisk.resolve(profile.id)).profile.capabilities, discovered);
  assert.deepEqual(calls, ['deepseek-flash']);
  const previous = await store.resolve(profile.id);
  const changed = await store.save({ ...profile, model: 'deepseek-v4-pro' });
  assert.equal(changed.capabilities?.source, 'provider-fallback');
  assert.deepEqual(previous.profile.capabilities, discovered);
  const restarted = new ProfileStore(dir, decrypt, discover);
  await restarted.init();
  assert.deepEqual((await restarted.resolve(profile.id)).profile, changed);
  await assert.rejects(restarted.save({ ...profile, id: gateway.id }), /API Key/);
  const custom = await restarted.save({ ...profile, id: gateway.id, baseUrl: gateway.baseUrl });
  assert.equal(custom.capabilities?.source, 'generic-fallback');
  assert.deepEqual(calls, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.doesNotMatch(await readFile(path, 'utf8'), /synthetic-auth-marker/);
  assert.doesNotMatch(JSON.stringify(restarted.list()), /synthetic-cipher|synthetic-auth-marker/);
});
