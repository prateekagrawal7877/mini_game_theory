import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const dataRoot = process.env.VERCEL ? '/tmp' : process.cwd()
const dataDir = path.join(dataRoot, 'data')
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
    experiment_id TEXT,
    run_type TEXT NOT NULL DEFAULT 'final',
    ab_group TEXT NOT NULL DEFAULT 'A',
    settings_json TEXT NOT NULL,
    bandit_means_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    participant_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    ab_group TEXT,
    final_completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS participant_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    final_completed_at TEXT,
    final_session_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(participant_id, experiment_id),
    FOREIGN KEY (participant_id) REFERENCES participants(participant_id)
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
    recalled_by_arm_json TEXT,
    perceived_averages_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS memory_recall_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    arm_index INTEGER NOT NULL,
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

  CREATE TABLE IF NOT EXISTS auth_otp_codes (
    email TEXT PRIMARY KEY,
    otp TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_login_tokens (
    token TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_auth_tokens (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
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

if (!sessionColumnNames.has('experiment_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN experiment_id TEXT')
}

const participantColumns = db
  .prepare('PRAGMA table_info(participants)')
  .all() as Array<{ name: string }>

const participantColumnNames = new Set(participantColumns.map((column) => column.name))

if (!participantColumnNames.has('ab_group')) {
  db.exec('ALTER TABLE participants ADD COLUMN ab_group TEXT')
}

const questionnaireColumns = db
  .prepare('PRAGMA table_info(questionnaires)')
  .all() as Array<{ name: string }>

const questionnaireColumnNames = new Set(questionnaireColumns.map((column) => column.name))

if (!questionnaireColumnNames.has('recalled_by_arm_json')) {
  db.exec('ALTER TABLE questionnaires ADD COLUMN recalled_by_arm_json TEXT')
}

if (!questionnaireColumnNames.has('perceived_averages_json')) {
  db.exec('ALTER TABLE questionnaires ADD COLUMN perceived_averages_json TEXT')
}

const memoryRecallColumns = db
  .prepare('PRAGMA table_info(memory_recall_items)')
  .all() as Array<{ name: string }>

const memoryRecallColumnNames = new Set(memoryRecallColumns.map((column) => column.name))

if (!memoryRecallColumnNames.has('arm_index')) {
  db.exec('ALTER TABLE memory_recall_items ADD COLUMN arm_index INTEGER NOT NULL DEFAULT 0')
}

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
