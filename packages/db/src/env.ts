import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// Load the monorepo root .env locally. Existing environment variables (e.g. on Railway) always win.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(root, '.env'), quiet: true });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
