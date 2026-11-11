import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export type Logger = (message: string) => void;

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrationStatus {
  version: string;
  name: string;
  state: 'applied' | 'pending' | 'checksum_mismatch' | 'missing_file';
  appliedAt: Date | null;
}

export interface LoginRoleSpec {
  url: string;
  kind: 'app' | 'system';
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TX_MARKER = /^--\s*jfs:no-transaction\b/m;
const LOCK_KEY = '7412093581';

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const out: MigrationFile[] = [];
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match)
      throw new Error(`Invalid migration filename "${file}" (expected NNNN_snake_name.sql)`);
    const version = match[1]!;
    const name = match[2]!;
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = (await readFile(path.join(dir, file), 'utf8'))
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
    out.push({
      version,
      name,
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transactional: !NO_TX_MARKER.test(sql),
    });
  }
  return out;
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'jfs-migrator' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureMetaTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS jfs_meta;
    CREATE TABLE IF NOT EXISTS jfs_meta.schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    );`);
}

async function fetchApplied(client: pg.Client): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT version, name, checksum, applied_at FROM jfs_meta.schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, r]));
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as {
      message: string;
      detail?: string;
      hint?: string;
      position?: string;
      where?: string;
    };
    return [
      e.message,
      e.detail && `detail: ${e.detail}`,
      e.hint && `hint: ${e.hint}`,
      e.where && `where: ${e.where}`,
      e.position && `position: ${e.position}`,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  return String(err);
}

export async function migrateUp(
  connectionString: string,
  dir: string,
  log: Logger = console.log,
): Promise<number> {
  const files = await loadMigrations(dir);
  return withClient(connectionString, async (client) => {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
    try {
      await ensureMetaTable(client);
      const applied = await fetchApplied(client);
      const onDisk = new Set(files.map((f) => f.version));
      for (const row of applied.values()) {
        if (!onDisk.has(row.version)) {
          throw new Error(
            `Migration ${row.version}_${row.name} is recorded as applied but its file is missing`,
          );
        }
      }
      let count = 0;
      for (const m of files) {
        const prev = applied.get(m.version);
        if (prev) {
          if (prev.checksum !== m.checksum) {
            throw new Error(
              `Migration ${m.file} was changed after it was applied (checksum mismatch). Create a new migration instead.`,
            );
          }
          continue;
        }
        const started = Date.now();
        log(`-> applying ${m.file}${m.transactional ? '' : ' (no transaction)'}`);
        try {
          if (m.transactional) await client.query('BEGIN');
          await client.query(m.sql);
          await client.query(
            'INSERT INTO jfs_meta.schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
            [m.version, m.name, m.checksum, Date.now() - started],
          );
          if (m.transactional) await client.query('COMMIT');
        } catch (err) {
          if (m.transactional) await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${m.file} failed: ${describeError(err)}`);
        }
        log(`OK ${m.file} (${Date.now() - started} ms)`);
        count++;
      }
      return count;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY])
        .catch(() => undefined);
    }
  });
}

export async function migrationStatus(
  connectionString: string,
  dir: string,
): Promise<MigrationStatus[]> {
  const files = await loadMigrations(dir);
  return withClient(connectionString, async (client) => {
    await ensureMetaTable(client);
    const applied = await fetchApplied(client);
    const result = files.map((f): MigrationStatus => {
      const a = applied.get(f.version);
      return {
        version: f.version,
        name: f.name,
        state: !a ? 'pending' : a.checksum === f.checksum ? 'applied' : 'checksum_mismatch',
        appliedAt: a?.applied_at ?? null,
      };
    });
    for (const a of applied.values()) {
      if (!files.some((f) => f.version === a.version)) {
        result.push({
          version: a.version,
          name: a.name,
          state: 'missing_file',
          appliedAt: a.applied_at,
        });
      }
    }
    return result.sort((x, y) => x.version.localeCompare(y.version));
  });
}

export async function ensureLoginRoles(
  ownerConnectionString: string,
  specs: LoginRoleSpec[],
  log: Logger = console.log,
): Promise<void> {
  const owner = decodeURIComponent(new URL(ownerConnectionString).username);
  await withClient(ownerConnectionString, async (client) => {
    for (const spec of specs) {
      const url = new URL(spec.url);
      const user = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (!user || !password)
        throw new Error(`${spec.kind} database URL must include a user and password`);
      if (user === owner)
        throw new Error(
          `${spec.kind} database user must differ from the migration owner "${owner}"`,
        );
      if (user === 'jfs_app' || user === 'jfs_system') throw new Error(`{spec.kind} database user cannot be the group role "{user}"; use a separate login name`);
      const ident = client.escapeIdentifier(user);
      const bypass = spec.kind === 'system' ? 'BYPASSRLS' : 'NOBYPASSRLS';
      const group = spec.kind === 'system' ? 'jfs_system' : 'jfs_app';
      const exists =
        ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount ?? 0) >
        0;
      await client.query(
        `${exists ? 'ALTER' : 'CREATE'} ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass} PASSWORD ${client.escapeLiteral(password)}`,
      );
      await client.query(`GRANT ${group} TO ${ident}`);
      log(
        `OK login role "${user}" (${spec.kind}${spec.kind === 'system' ? ', bypasses RLS' : ', RLS enforced'})`,
      );
    }
  });
}

export async function createMigrationFile(dir: string, rawName: string): Promise<string> {
  const name = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) throw new Error('Provide a migration name, e.g. pnpm db:new add_vehicles');
  const files = await loadMigrations(dir);
  const last = files.at(-1);
  const next = String((last ? Number(last.version) : 0) + 1).padStart(4, '0');
  const file = `${next}_${name}.sql`;
  await writeFile(
    path.join(dir, file),
    `-- ${file}\n-- To run outside a transaction, put the line "-- jfs:no-transaction" at the top.\n\n`,
    { flag: 'wx' },
  );
  return file;
}
