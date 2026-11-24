import { drive } from './drive.js';
import { github } from './github.js';
import { gmail } from './gmail.js';
import { outlook } from './outlook.js';
import type { CodeModule } from './types.js';

// Integrations whose tools are code, by the `module` their definition names.
export const MODULES: Record<string, CodeModule> = { gmail, github, drive, outlook };

export type { CodeModule, CodeTool } from './types.js';
