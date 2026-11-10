// Whether a page kept for a waiting browser click is still open: browser.ts answers,
// approvals.ts asks. A module of its own so neither has to load the other.
let alive: ((page: string) => boolean) | null = null;
export const setKeptPageCheck = (check: (page: string) => boolean) => void (alive = check);
export const keptPageAlive = (page: string) => (alive ? alive(page) : null);
