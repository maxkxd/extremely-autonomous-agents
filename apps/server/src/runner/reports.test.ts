import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { resetDbForTests, run as exec, setSetting } from './db.js';
import { reportDefault, reportDefaultForPrompt, reportDefaultsForPrompt, setReportDefault } from './reports.js';

before(() => resetDbForTests());

test("a default place for reports: set from a real place, never 'kept in the app'", () => {
  assert.equal(reportDefault('Max'), null);
  assert.match(reportDefaultForPrompt('Max'), /Max has no default place for reports yet/);
  assert.throws(() => setReportDefault('kept here in the app', 'files.write_file', 'x', 'Max'), /never a default/);
  assert.throws(() => setReportDefault('~/Documents/Agent stuff', 'a folder', 'x', 'Max'), /server\.tool/);
  setReportDefault('~/Documents/Marketing reports', 'computer_files.write_file', 'first place they named', 'Max');
  setReportDefault('~/Documents/Agent stuff', 'computer_files.write_file', 'a folder for everything the agents make', 'Max');
  assert.equal(reportDefault('Max')?.where, '~/Documents/Agent stuff');
  assert.match(reportDefaultForPrompt('Max'), /Max's default place for reports: ~\/Documents\/Agent stuff \(delivered with computer_files\.write_file\)\. An agent of theirs that reports goes there unless they name another place for it - don't ask them where\./);
});

test("in an organization each person has their own: Jo's reports don't go to the host's folder", () => {
  exec("DELETE FROM settings WHERE key IN ('report_defaults', 'report_default')");
  setSetting('host_person', 'Sam Rivera');
  setReportDefault('C:/Northside/Agent reports', 'computer_files.write_file', 'first place named', 'Sam Rivera');
  assert.equal(reportDefault('Jo Nguyen'), null);
  setReportDefault('email to the owner', 'gmail.send_to_me', 'Jo asked for email', 'Jo Nguyen');
  assert.equal(reportDefault('Sam Rivera')?.where, 'C:/Northside/Agent reports');
  assert.equal(reportDefault('jo nguyen')?.tool, 'gmail.send_to_me'); // by name, any case
  assert.equal(reportDefault()?.where, 'C:/Northside/Agent reports'); // no owner: the host's
  assert.match(reportDefaultsForPrompt(), /sam rivera: C:\/Northside\/Agent reports .*; jo nguyen: email to the owner/);
});

test("the one default from before there was one each carries over as the host's", () => {
  exec("DELETE FROM settings WHERE key IN ('report_defaults', 'report_default')");
  setSetting('host_person', 'Max');
  setSetting('report_default', { where: '~/Reports', tool: 'computer_files.write_file', why: 'x', at: 1 });
  assert.equal(reportDefault('Max')?.where, '~/Reports');
  assert.equal(reportDefault('Someone else'), null);
});

test('the first place a person names while building becomes theirs; a later one, or "the app", does not', async () => {
  const { firstReportPlace } = await import('../builder.js');
  exec("DELETE FROM settings WHERE key IN ('report_defaults', 'report_default')");
  firstReportPlace({ report_place: '' }, 'Jo Nguyen');
  firstReportPlace({ report_place: 'kept here in the app | files.write_file' }, 'Jo Nguyen');
  assert.equal(reportDefault('Jo Nguyen'), null);
  firstReportPlace({ report_place: '~/Northside/Agent reports | computer_files.write_file' }, 'Jo Nguyen');
  firstReportPlace({ report_place: 'email to the owner | gmail.send_to_me' }, 'Jo Nguyen'); // one agent's own place: the default stays
  assert.equal(reportDefault('Jo Nguyen')?.where, '~/Northside/Agent reports');
  assert.equal(reportDefault('Sam Rivera'), null);
});
