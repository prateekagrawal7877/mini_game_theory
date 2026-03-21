import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

const databaseUrl = process.env.DATABASE_URL
const localDatabaseName = process.env.PGDATABASE ?? 'mini_game_theory'

function isHostedDatabase(url: string): boolean {
  const normalized = url.toLowerCase()
  return !(normalized.includes('localhost') || normalized.includes('127.0.0.1'))
}

function createPool(targetDatabase?: string): Pool {
  if (databaseUrl) {
    return new Pool({
      connectionString: databaseUrl,
      ssl: isHostedDatabase(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    })
  }

  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: targetDatabase ?? localDatabaseName,
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD,
  })
}

let pool = createPool()

let dbInitPromise: Promise<void> | null = null

async function initializeDb(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS experiment_config (
      id INTEGER PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT experiment_config_singleton CHECK (id = 1)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      participant_id TEXT,
      experiment_id TEXT,
      run_type TEXT NOT NULL DEFAULT 'final',
      ab_group TEXT NOT NULL DEFAULT 'A',
      settings_json TEXT NOT NULL,
      bandit_means_json TEXT NOT NULL,
      CONSTRAINT sessions_run_type_valid CHECK (run_type IN ('practice', 'final')),
      CONSTRAINT sessions_ab_group_valid CHECK (ab_group IN ('A', 'B'))
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS participants (
      participant_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      ab_group TEXT,
      final_completed_at TEXT,
      CONSTRAINT participants_ab_group_valid CHECK (ab_group IN ('A', 'B') OR ab_group IS NULL)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS participant_experiments (
      id BIGSERIAL PRIMARY KEY,
      participant_id TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      final_completed_at TEXT,
      final_session_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(participant_id, experiment_id),
      CONSTRAINT participant_experiments_participant_fk
        FOREIGN KEY (participant_id) REFERENCES participants(participant_id) ON DELETE CASCADE,
      CONSTRAINT participant_experiments_session_fk
        FOREIGN KEY (final_session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS pulls (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      arm_index INTEGER NOT NULL,
      reward DOUBLE PRECISION NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT pulls_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS questionnaires (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      target_arm INTEGER NOT NULL,
      recalled_sequence_json TEXT NOT NULL,
      perceived_average DOUBLE PRECISION NOT NULL,
      recalled_by_arm_json TEXT,
      perceived_averages_json TEXT,
      created_at TEXT NOT NULL,
      CONSTRAINT questionnaires_session_fk
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS memory_recall_items (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      arm_index INTEGER NOT NULL,
      position_index INTEGER NOT NULL,
      recalled_reward DOUBLE PRECISION NOT NULL,
      actual_reward DOUBLE PRECISION,
      is_match BOOLEAN NOT NULL,
      recency_weight DOUBLE PRECISION NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT memory_recall_items_session_fk
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS metrics (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      total_reward DOUBLE PRECISION NOT NULL,
      average_reward DOUBLE PRECISION NOT NULL,
      best_arm_index INTEGER NOT NULL,
      best_arm_mean DOUBLE PRECISION NOT NULL,
      expected_regret DOUBLE PRECISION NOT NULL,
      recency_weighted_accuracy DOUBLE PRECISION,
      perceived_average_error DOUBLE PRECISION,
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT metrics_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS session_history (
      session_id TEXT PRIMARY KEY,
      participant_id TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT session_history_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS auth_otp_codes (
      email TEXT PRIMARY KEY,
      otp TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS auth_login_tokens (
      token TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS admin_auth_tokens (
      token TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  const defaultExperimentConfig = {
    title: 'Bandit Decision-Making Study',
    purpose:
      'This experiment studies how people learn from feedback under uncertainty and how different information views affect decision quality over repeated rounds.',
    instructions:
      'Your aim is to maximize total reward by selecting one arm per round. Rewards are binary (0 or 1). Some arms are better than others, so use feedback from earlier rounds to improve your choices.',
    exitAllowed: true,
    maxFinalExperimentsPerParticipant: 1,
    experiments: [
      {
        id: 'exp_1',
        label: 'Experiment 1',
        enabled: true,
        numArms: 2,
        armProbabilities: [0.65, 0.35],
        finalRounds: 30,
      },
    ],
    practiceEnabled: true,
    practiceConfig: {
      numArms: 2,
      armProbabilities: [0.5, 0.5],
      rounds: 10,
    },
    abTestingEnabled: true,
    defaultVisibilityMode: 'none',
    groupConfigs: {
      A: {
        visibilityMode: 'none',
        showRoundHistory: false,
        showArmPullCounts: false,
        showCurrentArmProbabilities: false,
        showCustomInstruction: true,
        customInstruction:
          'Group A condition: minimal feedback view. Focus on learning from immediate outcomes and strategy over time to maximize reward.',
      },
      B: {
        visibilityMode: 'full',
        showRoundHistory: true,
        showArmPullCounts: true,
        showCurrentArmProbabilities: true,
        showCustomInstruction: true,
        customInstruction:
          'Group B condition: full feedback view. Use round history, pull counts, and displayed reward probabilities to optimize your selections.',
      },
    },
  }

  await query(
    `INSERT INTO experiment_config (id, config_json, updated_at)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(defaultExperimentConfig), new Date().toISOString()]
  )
}

function ensureDbInitialized(): Promise<void> {
  if (!dbInitPromise) {
    dbInitPromise = initializeDb().catch(async (error: unknown) => {
      const code = (error as { code?: string })?.code

      // Local DX: create PGDATABASE automatically when it doesn't exist.
      if (!databaseUrl && code === '3D000') {
        const adminPool = createPool('postgres')
        try {
          const exists = await adminPool.query<{ exists: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
            [localDatabaseName]
          )

          if (!exists.rows[0]?.exists) {
            const safeDbName = localDatabaseName.replace(/"/g, '""')
            await adminPool.query(`CREATE DATABASE "${safeDbName}"`)
          }
        } finally {
          await adminPool.end()
        }

        await pool.end().catch(() => undefined)
        pool = createPool()
        await initializeDb()
        return
      }

      dbInitPromise = null
      throw error
    })
  }

  return dbInitPromise
}

function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  client?: PoolClient
): Promise<QueryResult<T>> {
  if (client) {
    return client.query<T>(text, params)
  }
  return pool.query<T>(text, params)
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export { pool, query, withTransaction, ensureDbInitialized }
