import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../env.js';
import {
  createMigrationFile,
  ensureLoginRoles,
  migrateUp,
  migrationStatus,
  type LoginRoleSpec,
} from '../migrator.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function main(): Promise<void> {
  const [command = 'up', ...args] = process.argv.slice(2);
  switch (command) {
    case 'up': {
      const url = requireEnv('DATABASE_URL');
      const applied = await migrateUp(url, dir);
      console.log(applied === 0 ? 'Database is up to date.' : `Applied ${applied} migration(s).`);
      const specs: LoginRoleSpec[] = [];
      if (process.env.APP_DATABASE_URL)
        specs.push({ url: process.env.APP_DATABASE_URL, kind: 'app' });
      if (process.env.SYSTEM_DATABASE_URL)
        specs.push({ url: process.env.SYSTEM_DATABASE_URL, kind: 'system' });
      if (specs.length > 0) await ensureLoginRoles(url, specs);
      break;
    }
    case 'status': {
      const rows = await migrationStatus(requireEnv('DATABASE_URL'), dir);
      if (rows.length === 0) console.log('No migrations found.');
      for (const r of rows) {
        const when = r.appliedAt ? r.appliedAt.toISOString() : '-';
        console.log(`${r.version}  ${r.state.padEnd(17)}  ${when}  ${r.name}`);
      }
      if (rows.some((r) => r.state === 'checksum_mismatch' || r.state === 'missing_file'))
        process.exitCode = 1;
      break;
    }
    case 'new': {
      const file = await createMigrationFile(dir, args.join('_'));
      console.log(`Created migrations/${file}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use: up | status | new <name>`);
  }
}

main().catch((err: unknown) => {
  console.error(`[migrate] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
