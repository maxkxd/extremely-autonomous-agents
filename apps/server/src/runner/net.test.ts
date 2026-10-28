import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlockedAddress, checkUrl, isPrivateIp, safeFetch } from './net.js';

test('private and local addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('agents cannot address this computer or its network', () => {
  for (const url of ['http://localhost:5175/api/connections', 'http://127.0.0.1:11434/api/tags', 'http://192.168.1.1/', 'http://[::1]/', 'http://router.local/', 'http://169.254.169.254/latest/meta-data/'])
    assert.throws(() => checkUrl(url), BlockedAddress, url);
  assert.throws(() => checkUrl('file:///C:/secret.txt'), BlockedAddress);
  assert.throws(() => checkUrl('not a url'), BlockedAddress);
  assert.equal(checkUrl('https://example.com/a?b=1').hostname, 'example.com');
});

test('a public name that resolves to a private address is refused at connect time', async () => {
  // localtest.me and its subdomains resolve to 127.0.0.1.
  await assert.rejects(() => safeFetch('http://localtest.me:5175/api/connections', { timeoutMs: 10_000 }), BlockedAddress);
});
