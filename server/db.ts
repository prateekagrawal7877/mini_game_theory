import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'bandit_game.sqlite')
const db = new Database(dbPath)

// Improve write concurrency for local analytics capture.
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS experiment_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    participant_id TEXT,
    run_type TEXT NOT NULL DEFAULT 'final',
    ab_group TEXT NOT NULL DEFAULT 'A',
    settings_json TEXT NOT NULL,
    bandit_means_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    participant_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    final_completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    arm_index INTEGER NOT NULL,
    reward REAL NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS questionnaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    target_arm INTEGER NOT NULL,
    recalled_sequence_json TEXT NOT NULL,
    perceived_average REAL NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS memory_recall_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    position_index INTEGER NOT NULL,
    recalled_reward REAL NOT NULL,
    actual_reward REAL,
    is_match INTEGER NOT NULL,
    recency_weight REAL NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    total_reward REAL NOT NULL,
    average_reward REAL NOT NULL,
    best_arm_index INTEGER NOT NULL,
    best_arm_mean REAL NOT NULL,
    expected_regret REAL NOT NULL,
    recency_weighted_accuracy REAL,
    perceived_average_error REAL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS session_history (
    session_id TEXT PRIMARY KEY,
    participant_id TEXT,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`)

const sessionColumns = db
  .prepare('PRAGMA table_info(sessions)')
  .all() as Array<{ name: string }>

const sessionColumnNames = new Set(sessionColumns.map((column) => column.name))

if (!sessionColumnNames.has('participant_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN participant_id TEXT')
}

if (!sessionColumnNames.has('run_type')) {
  db.exec("ALTER TABLE sessions ADD COLUMN run_type TEXT NOT NULL DEFAULT 'final'")
}

if (!sessionColumnNames.has('ab_group')) {
  db.exec("ALTER TABLE sessions ADD COLUMN ab_group TEXT NOT NULL DEFAULT 'A'")
}

const defaultExperimentConfig = {
  title: 'Bandit Decision-Making Study',
  purpose:
    'This study examines how people learn from rewards while making repeated decisions.',
  instructions:
    'In each round, choose one arm. Rewards are either 0 or 1. Try to maximize your total reward. After the game, you must complete a short memory questionnaire before finishing.',
  numArms: 2,
  armProbabilities: [0.65, 0.35],
  practiceEnabled: true,
  practiceRounds: 10,
  finalRounds: 30,
  abTestingEnabled: true,
  defaultVisibilityMode: 'last-3',
  groupConfigs: {
    A: { visibilityMode: 'full' },
    B: { visibilityMode: 'last-3' },
  },
}

const existingConfig = db
  .prepare('SELECT id FROM experiment_config WHERE id = 1')
  .get() as { id: number } | undefined

if (!existingConfig) {
  db.prepare('INSERT INTO experiment_config (id, config_json, updated_at) VALUES (1, ?, ?)').run(
    JSON.stringify(defaultExperimentConfig),
    new Date().toISOString()
  )
}

export default db
