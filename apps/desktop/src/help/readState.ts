// Which help topics this person has read, and which version of each.
//
// A topic is unread until its current version has been opened, so bumping a
// topic's version (topics.ts) lights its button up again for everyone.
// Kept behind a small store so it can move from this device to the person's
// account later without touching the button.

import { useSyncExternalStore } from 'react';
import { HELP_TOPICS, type HelpTopicId } from './topics';

type ReadVersions = Partial<Record<HelpTopicId, number>>;

export type HelpReadStore = {
  load: () => ReadVersions;
  save: (read: ReadVersions) => void;
};

const KEY = 'eaa.help.read';

// Default: this device's local storage.
export const localHelpStore: HelpReadStore = {
  load: () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as ReadVersions;
    } catch {
      return {};
    }
  },
  save: read => {
    try {
      localStorage.setItem(KEY, JSON.stringify(read));
    } catch {
      // Storage unavailable - help just glows again next time.
    }
  },
};

// Nothing kept: every page load starts with all help unread.
export const memoryHelpStore: HelpReadStore = { load: () => ({}), save: () => {} };

let store: HelpReadStore = localHelpStore;
let read: ReadVersions = store.load();
const listeners = new Set<() => void>();

export function setHelpStore(next: HelpReadStore) {
  store = next;
  read = store.load();
  listeners.forEach(l => l());
}

export function markHelpRead(id: HelpTopicId) {
  if (read[id] === HELP_TOPICS[id].version) return;
  read = { ...read, [id]: HELP_TOPICS[id].version };
  store.save(read);
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useHelpUnread(id: HelpTopicId): boolean {
  const version = useSyncExternalStore(subscribe, () => read[id]);
  return version !== HELP_TOPICS[id].version;
}
