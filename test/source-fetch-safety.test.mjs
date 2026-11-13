import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { verifyWorkerSources } from '../src/web-verification.mjs';

const finding = (url) => `- Fact (${url}) — Quote: "Exact quote" VERIFIED=yes`;
const publicAddress = { address: '93.184.216.34', family: 4 };

test('FAILS_ON_OLD: source verification blocks loopback without calling fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
  const checked = await verifyWorkerSources(finding('http://127.0.0.1/private'));
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(checked.sourceVerification[0].reason, 'blocked_address');
  assert.doesNotMatch(checked.text, /VERIFIED=yes/);
});

test('FAILS_ON_OLD: redirects to private addresses are blocked before the next fetch', async (t) => {
  t.mock.method(dns, 'lookup', async () => [publicAddress]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }));
  const checked = await verifyWorkerSources(finding('https://sources.example/start'));
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0].arguments[1].redirect, 'manual');
  assert.equal(checked.sourceVerification[0].reason, 'blocked_address');
  assert.doesNotMatch(checked.text, /VERIFIED=yes/);
});

test('private, link-local, encoded loopback and mapped IPv6 literals never reach fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
  for (const host of [
    '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '127.0.0.2', '169.254.169.254', '127.1', '2130706433', '0x7f000001',
    '[::]', '[::1]', '[fc00::1]', '[fdff::1]', '[fe80::1]', '[febf::1]',
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:192.168.0.1]',
  ]) {
    const checked = await verifyWorkerSources(finding(`http://${host}/secret`));
    assert.equal(checked.sourceVerification[0].reason, 'blocked_address', host);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('every DNS answer is checked, including mixed public/private answers', async (t) => {
  let answers;
  const lookupMock = t.mock.method(dns, 'lookup', async () => answers);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.2.1', '192.168.0.1', '169.254.0.1', '::1', 'fc00::1', 'fe80::1']) {
    answers = [publicAddress, { address, family: address.includes(':') ? 6 : 4 }];
    const checked = await verifyWorkerSources(finding('https://sources.example/secret'));
    assert.equal(checked.sourceVerification[0].reason, 'blocked_address', address);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(lookupMock.mock.callCount(), 8);
  assert.equal(lookupMock.mock.calls[0].arguments[1].all, true);
});

test('redirect hostnames are resolved again and private DNS answers block the next request', async (t) => {
  const hosts = [];
  t.mock.method(dns, 'lookup', async (host) => {
    hosts.push(host);
    return host === 'sources.example' ? [publicAddress] : [{ address: '192.168.0.10', family: 4 }];
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 307, headers: { location: 'https://internal.example/secret' } }));
  const checked = await verifyWorkerSources(finding('https://sources.example/start'));
  assert.deepEqual(hosts, ['sources.example', 'internal.example']);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(checked.sourceVerification[0].reason, 'blocked_address');
});

test('public relative redirects retain quote verification and use manual fetch', async (t) => {
  t.mock.method(dns, 'lookup', async () => [publicAddress]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => String(url).endsWith('/start')
    ? new Response(null, { status: 302, headers: { location: '/article' } })
    : new Response('Exact quote'));
  const checked = await verifyWorkerSources(finding('https://sources.example/start'));
  assert.equal(checked.sourceVerification[0].verified, 'yes');
  assert.equal(checked.sourceVerification[0].status, 200);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.ok(fetchMock.mock.calls.every((call) => call.arguments[1].redirect === 'manual'));
});

test('redirect loops stop after at most three hops', async (t) => {
  t.mock.method(dns, 'lookup', async () => [publicAddress]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 308, headers: { location: '/loop' } }));
  const checked = await verifyWorkerSources(finding('https://sources.example/loop'));
  assert.equal(fetchMock.mock.callCount(), 4); // Initial request plus three redirects.
  assert.equal(checked.sourceVerification[0].verified, 'unverified');
  assert.equal(checked.sourceVerification[0].reason, 'no_fetch');
});

test('failed DNS resolution never reaches fetch', async (t) => {
  t.mock.method(dns, 'lookup', async () => { throw new Error('ENOTFOUND'); });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
  const checked = await verifyWorkerSources(finding('https://sources.example/offline'));
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(checked.sourceVerification[0].reason, 'no_fetch');
});
