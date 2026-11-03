import { useSyncExternalStore } from 'react';
import { offline, onOffline } from './account';

// While the organization's host is offline nothing can change there: every
// control that would change something is greyed out and says so on hover,
// never with a message after it's pressed. null while the host is online.
export const OFFLINE_WHY = "The host is offline. This can be done once it's back.";
export const useOffline = () => useSyncExternalStore(onOffline, () => (offline.since ? OFFLINE_WHY : null));
