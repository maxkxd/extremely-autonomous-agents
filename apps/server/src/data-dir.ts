// The agency's data folder on a Linux host (the cloud container), from EAA_DATA_DIR.
//
// A variable set from Git Bash on Windows (for example with the Railway CLI) has a
// leading "/data/agency" rewritten to "C:/Program Files/Git/data/agency". On the
// container that is a relative path, so the agency looked for its bundle (and its
// own folder) under the working folder, and waited for ever. A Git Bash prefix is
// taken off, giving the path that was typed; any other Windows path is not a folder
// on this host, so it is refused and the default is used.

export const DEFAULT_DATA_DIR = '/data/agency';

const GIT_BASH_PREFIX = /^[A-Za-z]:\/Program Files( \(x86\))?\/Git(?=\/|$)/i;
const DRIVE_PATH = /^[A-Za-z]:(\/|$)/;

export type DataDir = { dir: string; note?: string };

// `note` says what was wrong, when something was: the caller logs it.
export function normaliseDataDir(raw: string | undefined): DataDir {
  const value = (raw ?? '').trim();
  if (!value) return { dir: DEFAULT_DATA_DIR };
  const slashes = value.replace(/\\/g, '/');
  if (!DRIVE_PATH.test(slashes)) return { dir: value };
  const fixed = slashes.replace(GIT_BASH_PREFIX, '') || '/';
  if (fixed.startsWith('/') && fixed !== '/' && !DRIVE_PATH.test(fixed)) {
    return { dir: fixed, note: `EAA_DATA_DIR is "${value}", a Windows path (Git Bash turns a leading "/" into its install folder): using "${fixed}". Set the variable to "${fixed}".` };
  }
  return { dir: DEFAULT_DATA_DIR, note: `EAA_DATA_DIR is "${value}", a Windows path that is not a folder on this host: using "${DEFAULT_DATA_DIR}". Set the variable to a path inside the container.` };
}
