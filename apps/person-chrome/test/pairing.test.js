import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLink, encodeLink, browserKind, defaultLabel } from '../pairing.js';

test('a pairing link decodes to the address, code and agency name', () => {
  const link = encodeLink({ u: 'ws://127.0.0.1:5175/api/browser-link', c: 'K7Q2-9XPD', n: 'Test Agency' });
  assert.match(link, /^eaa1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeLink(link), { url: 'ws://127.0.0.1:5175/api/browser-link', code: 'K7Q2-9XPD', name: 'Test Agency' });
  // As the pairing page's hash, or pasted with spaces around it.
  assert.equal(decodeLink('#' + link).code, 'K7Q2-9XPD');
  assert.equal(decodeLink('  ' + link + '\n').code, 'K7Q2-9XPD');
  assert.equal(decodeLink('http://127.0.0.1:5175/browser/connect#' + link).code, 'K7Q2-9XPD');
});

test('names outside ASCII survive', () => {
  const link = encodeLink({ u: 'wss://agency.example.com/api/browser-link', c: 'AAAA-BBBB', n: 'Café Ünïcode' });
  assert.equal(decodeLink(link).name, 'Café Ünïcode');
});

test('no name: the host stands in', () => {
  assert.equal(decodeLink(encodeLink({ u: 'wss://agency.example.com/api/browser-link', c: 'AAAA-BBBB' })).name, 'agency.example.com');
});

test('bad links are refused with plain words', () => {
  assert.throws(() => decodeLink('hello'), /not an EXTREMELY pairing link/);
  assert.throws(() => decodeLink('eaa1:!!!'), /cut short/);
  assert.throws(() => decodeLink('eaa1:' + Buffer.from('{"c":"A"}').toString('base64url')), /no agency address/);
  assert.throws(() => decodeLink(encodeLink({ u: 'https://agency.example.com/', c: 'A' })), /not a WebSocket/);
  assert.throws(() => decodeLink(encodeLink({ u: 'wss://agency.example.com/', c: '' })), /no code/);
  // Plain ws to another computer would show the token to the network.
  assert.throws(() => decodeLink(encodeLink({ u: 'ws://agency.example.com/api/browser-link', c: 'A' })), /secure \(wss\)/);
  assert.equal(decodeLink(encodeLink({ u: 'ws://localhost:5175/api/browser-link', c: 'A' })).url, 'ws://localhost:5175/api/browser-link');
});

test('browser kind and default name', () => {
  assert.equal(browserKind('Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'edge');
  assert.equal(browserKind('Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36'), 'chrome');
  assert.equal(defaultLabel('edge'), 'Edge');
  assert.equal(defaultLabel('chrome'), 'Chrome');
});
