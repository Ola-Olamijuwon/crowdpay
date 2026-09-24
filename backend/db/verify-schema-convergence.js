/**
 * CI check: prove schema.sql and the migration history converge (#800).
 *
 * Run after `npm run migrate:fresh` (psql -f db/schema.sql && migrate up
 * --bootstrap-schema) against a scratch database. Asserts that:
 *   1. feature_flags matches its canonical shape (key/default_enabled) —
 *      the table schema.sql previously defined with an incompatible
 *      (id/name/rollout_pct) shape that broke the /api/feature-flags routes;
 *   2. both bootstrap sources landed: base tables from schema.sql (api_keys
 *      is only ever created there) AND tables created only by migrations
 *      (reward_tiers is only ever created by 20260623_reward_tiers.sql).
 *
 * Exits non-zero with a descriptive message when the two paths drift apart.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const failures = [];
  try {
    const { rows: featureFlagCols } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'feature_flags'
        ORDER BY column_name`
    );
    const actual = featureFlagCols.map((r) => r.column_name);
    const expected = ['default_enabled', 'description', 'enabled', 'key', 'updated_at'];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `feature_flags columns drift: expected [${expected.join(', ')}], got [${actual.join(', ')}]`
      );
    }

    const { rows: legacyCols } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM information_schema.columns
        WHERE table_name = 'feature_flags'
          AND column_name IN ('id', 'name', 'rollout_pct', 'target_roles', 'target_user_ids', 'variants')`
    );
    if (legacyCols[0].n > 0) {
      failures.push(
        `feature_flags still carries legacy schema.sql-only columns (${legacyCols[0].n} found)`
      );
    }

    const { rows: flagRows } = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flags');
    if (flagRows[0].n < 4) {
      failures.push(`feature_flags seed rows missing: expected >= 4, found ${flagRows[0].n}`);
    }

    for (const table of ['users', 'campaigns', 'contributions']) {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [table]
      );
      if (!rows.length) failures.push(`base table '${table}' missing after converge run`);
    }

    // Only created by schema.sql (never by a migration).
    const { rows: apiKeyTable } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'api_keys'`
    );
    if (!apiKeyTable.length) {
      failures.push("schema.sql-only table 'api_keys' missing — schema.sql did not run");
    }

    // Only created by 20260623_reward_tiers.sql (never by schema.sql).
    const { rows: migrationOnly } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'reward_tiers'`
    );
    if (!migrationOnly.length) {
      failures.push(
        "migration-only table 'reward_tiers' missing — migrations did not run on top of schema.sql"
      );
    }
  } finally {
    await pool.end();
  }

  if (failures.length) {
    console.error('[verify-schema] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify-schema] OK: schema.sql and migrations converge.');
}

main().catch((err) => {
  console.error('[verify-schema] Failed to run check:', err.message);
  process.exitCode = 1;
});
