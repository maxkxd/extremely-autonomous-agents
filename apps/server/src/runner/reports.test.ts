import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { resetDbForTests } from './db.js';
import { reportDefault, reportDefaultForPrompt, setReportDefault } from './reports.js';

before(() => resetDbForTests());

test("the agency's default place for reports: set from a real place, never 'kept in the app'", () => {
  assert.equal(reportDefault(), null);
  assert.match(reportDefaultForPrompt(), /no default place for reports yet/);
  assert.throws(() => setReportDefault('kept here in the app', 'files.write_file', 'x'), /never the default/);
  assert.throws(() => setReportDefault('~/Documents/Agent stuff', 'a folder', 'x'), /server\.tool/);
  setReportDefault('C:\\Users\\max\\Documents\\Marketing reports', 'computer_files.write_file', 'first place they named');
  setReportDefault('C:\\Users\\max\\Documents\\Agent stuff', 'computer_files.write_file', 'a folder for everything the agents make');
  assert.equal(reportDefault()?.where, 'C:\\Users\\max\\Documents\\Agent stuff');
  assert.match(reportDefaultForPrompt(), /Agent stuff \(delivered with computer_files\.write_file\)\. An agent that reports goes there unless the person names another place for it - don't ask them where\./);
});
