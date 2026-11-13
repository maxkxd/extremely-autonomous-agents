import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_ASK } from './tools.js';

test('a request asking the person to approve or sign off is caught', () => {
  for (const what of [
    'Max: approve the Resell Shelf strategy pack (PDF Vault copy)',
    'Approve the launch post for Friday',
    'Please sign off the pricing page',
    'Need your sign-off on the brand sheet',
    'Your approval on the outreach list',
    'Green light for the ad spend plan',
  ])
    assert.ok(APPROVAL_ASK.test(what), what);
});

test('ordinary requests are not', () => {
  for (const what of [
    'Connect Zoho CRM so I can log leads',
    'Set up the event sentry.new_issue',
    'Tool to submit strategy packs for approval',
    'Sign in to Facebook so I can read the two groups',
    'Put YouTube for @AgentsGoneRogue live to upload 3 Shorts',
    'Rewrite my instructions the way my person asked in my chat',
    'Budget for Veo video generation this month',
  ])
    assert.ok(!APPROVAL_ASK.test(what), what);
});
