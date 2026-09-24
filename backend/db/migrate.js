require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const {
  listUpMigrationFilenames,
  readUpSql,
  readDownSql,
  fileHashFor,
  downFilenameFor,
  ensureSchemaMigrationsTable,
  loadApplied,
} = require('./migrateLib');

// Match backend/.env.example and docker-compose db service defaults.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMMAND = process.argv[2] || 'up';

// When running after `psql -f db/schema.sql` (the `migrate:fresh` flow), a few
// early migrations duplicate tables/columns that schema.sql already provides
// (e.g. 20260401 creates users/campaigns/contributions). Those objects are
// part of the canonical base schema snapshot and their final shape lives in
// schema.sql, so re-creating them is unnecessary and would abort the run.
//
// `--bootstrap-schema` (or MIGRATE_BOOTSTRAP_SCHEMA=1) makes `up` skip a
// migration whose objects already exist (Postgres "duplicate_*" error codes)
// AFTER a full schema.sql bootstrap — never on a migrations-only install
// (`npm run migrate` stays strict). Already-applied migrations are never
// edited, so deployed environments keep their recorded hashes intact.
const BOOTSTRAP_SCHEMA =
  process.argv.includes('--bootstrap-schema') || process.env.MIGRATE_BOOTSTRAP_SCHEMA === '1';

// PostgreSQL ERRCODEs for "this already exists" failures.
const ALREADY_CREATED_CODES = new Set([
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42P04', // duplicate_object
  '42710', // duplicate_object (constraints/indexes on existing objects)
]);

async function runUp() {
  const client = await pool.connect();
  try {
    await ensureSchemaMigrationsTable(client);
    const appliedRows = await loadApplied(client);
    const appliedMap = new Map(appliedRows.map((r) => [r.filename, r]));

    // Verify that already-applied migrations haven't been edited in place.
    for (const file of listUpMigrationFilenames()) {
      const record = appliedMap.get(file);
      if (!record || !record.file_hash) continue;
      if (record.file_hash !== fileHashFor(file)) {
        throw new Error(
          `Migration '${file}' was applied but its content has changed since then ` +
            `(hash mismatch). Do not edit an applied migration - add a new one instead.`
        );
      }
    }

    let count = 0;
    for (const file of listUpMigrationFilenames()) {
      if (appliedMap.has(file)) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }
      const sql = readUpSql(file);
      const hash = fileHashFor(file);
      try {
        console.log(`[migrate] Applying: ${file}`);
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, file_hash) VALUES ($1, $2)',
          [file, hash]
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (BOOTSTRAP_SCHEMA && err.code && ALREADY_CREATED_CODES.has(err.code)) {
          // schema.sql already provides the canonical version of this object.
          // Record the migration as applied so later incremental migrations
          // (which assume it ran) proceed normally (#800).
          console.log(
            `[migrate] Skipping '${file}': objects already present via schema.sql ` +
              `(${err.code}: ${err.message})`
          );
          await client.query('BEGIN');
          await client.query(
            'INSERT INTO schema_migrations (filename, file_hash) VALUES ($1, $2)',
            [file, hash]
          );
          await client.query('COMMIT');
          count++;
          continue;
        }
        throw err;
      }
    }

    console.log(`[migrate] Done. ${count} migration(s) applied.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runStatus() {
  const client = await pool.connect();
  try {
    await ensureSchemaMigrationsTable(client);
    const appliedRows = await loadApplied(client);
    const appliedMap = new Map(appliedRows.map((r) => [r.filename, r]));

    const files = listUpMigrationFilenames();
    const rows = files.map((file) => {
      const record = appliedMap.get(file);
      let status = 'PENDING';
      let appliedAt = '';
      if (record) {
        appliedAt = record.applied_at instanceof Date
          ? record.applied_at.toISOString()
          : String(record.applied_at);
        status =
          record.file_hash && record.file_hash !== fileHashFor(file)
            ? 'APPLIED (HASH MISMATCH)'
            : 'APPLIED';
      }
      return { file, status, appliedAt };
    });

    console.log('Migration status:');
    console.log('-----------------');
    for (const r of rows) {
      const at = r.appliedAt ? ` @ ${r.appliedAt}` : '';
      console.log(`  ${r.status.padEnd(24)} ${r.file}${at}`);
    }
    const pending = rows.filter((r) => r.status === 'PENDING').length;
    const applied = rows.length - pending;
    console.log('-----------------');
    console.log(`${applied} applied, ${pending} pending (${rows.length} total).`);
  } catch (err) {
    console.error('[migrate:status] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runDown(count) {
  const client = await pool.connect();
  try {
    await ensureSchemaMigrationsTable(client);
    const appliedRows = await loadApplied(client);
    const appliedSet = new Set(appliedRows.map((r) => r.filename));

    const appliedSeq = listUpMigrationFilenames().filter((f) => appliedSet.has(f));
    const toRollBack = appliedSeq.slice(-count).reverse();

    if (toRollBack.length === 0) {
      console.log('[migrate:down] No applied migrations to roll back.');
      return;
    }

    for (const file of toRollBack) {
      const down = readDownSql(file);
      if (down === null || down === undefined) {
        console.error(
          `[migrate:down] No down migration found for '${file}' ` +
            `(expected ${downFilenameFor(file)}). Skipping.`
        );
        continue;
      }
      console.log(`[migrate:down] Rolling back: ${file}`);
      await client.query('BEGIN');
      await client.query(down);
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [file]);
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate:down] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  switch (COMMAND) {
    case 'up':
    case 'migrate':
      await runUp();
      break;
    case 'status':
      await runStatus();
      break;
    case 'down': {
      const n = Number(process.argv[3]);
      await runDown(Number.isFinite(n) ? n : 1);
      break;
    }
    default:
      console.error(`Unknown command: ${COMMAND}`);
      console.error('Usage: node db/migrate.js [up|status|down [count]] [--bootstrap-schema]');
      console.error('  --bootstrap-schema  skip migrations whose objects already exist after');
      console.error('                      `psql -f db/schema.sql` (used by npm run migrate:fresh)');
      process.exitCode = 1;
      await pool.end();
  }
}

main();
