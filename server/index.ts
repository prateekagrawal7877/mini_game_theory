import cors from 'cors'
import express from 'express'
import db from './db'
import crypto from 'node:crypto'

type VisibilityMode = 'none' | 'last-3' | 'full' | 'summary'

type SessionSettings = {
  numArms: number
  rounds: number
  visibilityMode: VisibilityMode
}

type ABGroup = 'A' | 'B'

type RunType = 'practice' | 'final'

type ExperimentConfig = {
  title: string
  purpose: string
  instructions: string
  numArms: number
  armProbabilities: number[]
  practiceEnabled: boolean
  practiceRounds: number
  finalRounds: number
  abTestingEnabled: boolean
  defaultVisibilityMode: VisibilityMode
  groupConfigs: {
    A: { visibilityMode: VisibilityMode }
    B: { visibilityMode: VisibilityMode }
  }
}

type Pull = {
  roundIndex: number
  armIndex: number
  reward: number
}

type CompletionPayload = {
  runType: RunType
  pulls: Pull[]
  questionnaire: {
    targetArm: number
    recalledSequence: number[]
    perceivedAverage: number
  }
  metrics: {
    totalReward: number
    averageReward: number
    bestArmIndex: number
    bestArmMean: number
    expectedRegret: number
    recencyWeightedAccuracy: number | null
    perceivedAverageError: number | null
    [key: string]: unknown
  }
}

const app = express()
const port = Number(process.env.PORT ?? 8787)
const adminPassword = process.env.ADMIN_PASSWORD ?? 'change-me-now'
const adminTokens = new Map<string, number>()

app.use(cors())
app.use(express.json({ limit: '2mb' }))

const insertSession = db.prepare(
  `INSERT INTO sessions (
      id,
      created_at,
      participant_id,
      run_type,
      ab_group,
      settings_json,
      bandit_means_json
    ) VALUES (
      @id,
      @created_at,
      @participant_id,
      @run_type,
      @ab_group,
      @settings_json,
      @bandit_means_json
    )`
)

const insertPull = db.prepare(
  `INSERT INTO pulls (session_id, round_index, arm_index, reward, created_at)
   VALUES (@session_id, @round_index, @arm_index, @reward, @created_at)`
)

const insertQuestionnaire = db.prepare(
  `INSERT INTO questionnaires (session_id, target_arm, recalled_sequence_json, perceived_average, created_at)
   VALUES (@session_id, @target_arm, @recalled_sequence_json, @perceived_average, @created_at)`
)

const insertMetrics = db.prepare(
  `INSERT INTO metrics (
      session_id,
      total_reward,
      average_reward,
      best_arm_index,
      best_arm_mean,
      expected_regret,
      recency_weighted_accuracy,
      perceived_average_error,
      metrics_json,
      created_at
    ) VALUES (
      @session_id,
      @total_reward,
      @average_reward,
      @best_arm_index,
      @best_arm_mean,
      @expected_regret,
      @recency_weighted_accuracy,
      @perceived_average_error,
      @metrics_json,
      @created_at
    )`
)

const insertMemoryRecallItem = db.prepare(
  `INSERT INTO memory_recall_items (
      session_id,
      position_index,
      recalled_reward,
      actual_reward,
      is_match,
      recency_weight,
      created_at
    ) VALUES (
      @session_id,
      @position_index,
      @recalled_reward,
      @actual_reward,
      @is_match,
      @recency_weight,
      @created_at
    )`
)

const upsertSessionHistory = db.prepare(
  `INSERT INTO session_history (session_id, participant_id, snapshot_json, created_at)
   VALUES (@session_id, @participant_id, @snapshot_json, @created_at)
   ON CONFLICT(session_id) DO UPDATE SET
     participant_id = excluded.participant_id,
     snapshot_json = excluded.snapshot_json,
     created_at = excluded.created_at`
)

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function randomMean(): number {
  return Number((0.2 + Math.random() * 0.6).toFixed(4))
}

function buildDefaultArmProbabilities(numArms: number): number[] {
  if (numArms === 2) {
    return [0.65, 0.35]
  }

  if (numArms <= 1) {
    return [0.5]
  }

  return Array.from({ length: numArms }, (_, index) => {
    const ratio = index / (numArms - 1)
    const value = 0.8 - ratio * 0.6
    return Number(value.toFixed(3))
  })
}

function normalizeArmProbabilities(raw: unknown, numArms: number): number[] {
  const parsed = Array.isArray(raw)
    ? raw
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.min(1, Math.max(0, Number(value.toFixed(4)))))
    : []

  if (parsed.length !== numArms) {
    return buildDefaultArmProbabilities(numArms)
  }

  return parsed
}

function getExperimentConfig(): ExperimentConfig {
  const row = db
    .prepare('SELECT config_json FROM experiment_config WHERE id = 1')
    .get() as { config_json: string } | undefined

  if (!row) {
    throw new Error('Experiment config missing')
  }

  const raw = JSON.parse(row.config_json) as Partial<ExperimentConfig> & {
    [key: string]: unknown
  }

  const numArms = Number(raw.numArms ?? 2)
  const normalizedNumArms = Number.isInteger(numArms) && numArms >= 2 && numArms <= 20 ? numArms : 2

  return {
    title: String(raw.title ?? 'Bandit Decision-Making Study'),
    purpose: String(
      raw.purpose ??
        'This study examines how people learn from rewards while making repeated decisions.'
    ),
    instructions: String(
      raw.instructions ??
        'In each round, choose one arm. Rewards are either 0 or 1. Try to maximize your total reward. After the game, you must complete a short memory questionnaire before finishing.'
    ),
    numArms: normalizedNumArms,
    armProbabilities: normalizeArmProbabilities(raw.armProbabilities, normalizedNumArms),
    practiceEnabled: Boolean(raw.practiceEnabled ?? true),
    practiceRounds: Number(raw.practiceRounds ?? 10),
    finalRounds: Number(raw.finalRounds ?? 30),
    abTestingEnabled: Boolean(raw.abTestingEnabled ?? true),
    defaultVisibilityMode: (raw.defaultVisibilityMode as VisibilityMode) ?? 'last-3',
    groupConfigs: {
      A: { visibilityMode: (raw.groupConfigs?.A?.visibilityMode as VisibilityMode) ?? 'full' },
      B: {
        visibilityMode: (raw.groupConfigs?.B?.visibilityMode as VisibilityMode) ?? 'last-3',
      },
    },
  }
}

function saveExperimentConfig(config: ExperimentConfig): void {
  db.prepare('UPDATE experiment_config SET config_json = ?, updated_at = ? WHERE id = 1').run(
    JSON.stringify(config),
    new Date().toISOString()
  )
}

function chooseGroup(config: ExperimentConfig): ABGroup {
  if (!config.abTestingEnabled) {
    return 'A'
  }

  return Math.random() < 0.5 ? 'A' : 'B'
}

function getVisibilityMode(config: ExperimentConfig, group: ABGroup): VisibilityMode {
  if (!config.abTestingEnabled) {
    return config.defaultVisibilityMode
  }

  return config.groupConfigs[group].visibilityMode
}

function validateVisibilityMode(mode: unknown): mode is VisibilityMode {
  return ['none', 'last-3', 'full', 'summary'].includes(String(mode))
}

function validateExperimentConfig(config: ExperimentConfig): string | null {
  if (!config.title?.trim()) {
    return 'title is required'
  }
  if (!config.purpose?.trim()) {
    return 'purpose is required'
  }
  if (!config.instructions?.trim()) {
    return 'instructions are required'
  }
  if (!Number.isInteger(config.numArms) || config.numArms < 2 || config.numArms > 20) {
    return 'numArms must be an integer between 2 and 20'
  }
  if (!Array.isArray(config.armProbabilities) || config.armProbabilities.length !== config.numArms) {
    return 'armProbabilities must contain exactly one value per arm'
  }
  if (
    config.armProbabilities.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1
    )
  ) {
    return 'Each arm probability must be between 0 and 1'
  }
  if (!Number.isInteger(config.practiceRounds) || config.practiceRounds < 3 || config.practiceRounds > 200) {
    return 'practiceRounds must be an integer between 3 and 200'
  }
  if (!Number.isInteger(config.finalRounds) || config.finalRounds < 5 || config.finalRounds > 500) {
    return 'finalRounds must be an integer between 5 and 500'
  }
  if (!validateVisibilityMode(config.defaultVisibilityMode)) {
    return 'defaultVisibilityMode must be one of none, last-3, full, summary'
  }
  if (!validateVisibilityMode(config.groupConfigs?.A?.visibilityMode)) {
    return 'groupConfigs.A.visibilityMode must be valid'
  }
  if (!validateVisibilityMode(config.groupConfigs?.B?.visibilityMode)) {
    return 'groupConfigs.B.visibilityMode must be valid'
  }
  return null
}

function requireAdminToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = String(req.header('x-admin-token') ?? '')

  if (!token || !adminTokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized admin access.' })
    return
  }

  next()
}

function parseSessionSettings(sessionRow: { settings_json: string }): SessionSettings {
  return JSON.parse(sessionRow.settings_json) as SessionSettings
}

function deleteSessionData(sessionId: string): void {
  const deleteTransaction = db.transaction(() => {
    db.prepare('DELETE FROM pulls WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM questionnaires WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM memory_recall_items WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM metrics WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_history WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  })

  deleteTransaction()
}

function normalizeParticipantId(input: unknown): string {
  return String(input ?? '').trim().toUpperCase()
}

function isValidParticipantId(participantId: string): boolean {
  return /^[A-Z0-9_-]{4,32}$/.test(participantId)
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/admin/login', (req, res) => {
  const providedPassword = String(req.body?.password ?? '')

  if (!providedPassword || providedPassword !== adminPassword) {
    res.status(401).json({ error: 'Invalid admin password.' })
    return
  }

  const token = crypto.randomBytes(24).toString('hex')
  adminTokens.set(token, Date.now())

  res.json({ token })
})

app.get('/api/admin/experiment', requireAdminToken, (_req, res) => {
  const config = getExperimentConfig()
  res.json({ config })
})

app.put('/api/admin/experiment', requireAdminToken, (req, res) => {
  const proposedConfig = req.body?.config as ExperimentConfig
  const validationError = validateExperimentConfig(proposedConfig)

  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  saveExperimentConfig(proposedConfig)
  res.json({ ok: true, config: proposedConfig })
})

app.get('/api/admin/sessions', requireAdminToken, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.created_at,
         s.participant_id,
         s.run_type,
         s.ab_group,
         m.total_reward,
         m.average_reward,
         m.expected_regret,
         m.recency_weighted_accuracy,
         m.perceived_average_error
       FROM sessions s
       LEFT JOIN metrics m ON m.session_id = s.id
       ORDER BY s.created_at DESC
       LIMIT 200`
    )
    .all() as Array<Record<string, unknown>>

  res.json({ rows })
})

app.delete('/api/admin/history/:sessionId', requireAdminToken, (req, res) => {
  const sessionId = String(req.params.sessionId)
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as
    | { id: string }
    | undefined

  if (!exists) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  deleteSessionData(sessionId)

  res.json({ ok: true, deletedSessionId: sessionId })
})

app.delete('/api/admin/history', requireAdminToken, (_req, res) => {
  const deleteAllTransaction = db.transaction(() => {
    db.prepare('DELETE FROM pulls').run()
    db.prepare('DELETE FROM questionnaires').run()
    db.prepare('DELETE FROM memory_recall_items').run()
    db.prepare('DELETE FROM metrics').run()
    db.prepare('DELETE FROM session_history').run()
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM participants').run()
  })

  deleteAllTransaction()

  res.json({ ok: true })
})

app.get('/api/participant/experiment', (_req, res) => {
  const config = getExperimentConfig()

  res.json({
    title: config.title,
    purpose: config.purpose,
    instructions: config.instructions,
    practiceEnabled: config.practiceEnabled,
  })
})

app.post('/api/sessions/start', (req, res) => {
  const participantId = normalizeParticipantId(req.body?.participantId)
  const requestedRunType = String(req.body?.runType ?? 'final')
  const runType: RunType = requestedRunType === 'practice' ? 'practice' : 'final'

  if (!participantId) {
    res.status(400).json({
      error: 'Participant ID is required. Use 4-32 chars: letters, numbers, _ or -.',
    })
    return
  }

  if (!isValidParticipantId(participantId)) {
    res.status(400).json({
      error: 'Invalid Participant ID format. Use 4-32 chars: letters, numbers, _ or -.',
    })
    return
  }

  const config = getExperimentConfig()

  const participantRow = db
    .prepare('SELECT participant_id, final_completed_at FROM participants WHERE participant_id = ?')
    .get(participantId) as { participant_id: string; final_completed_at: string | null } | undefined

  if (!participantRow) {
    db.prepare('INSERT INTO participants (participant_id, created_at, final_completed_at) VALUES (?, ?, NULL)').run(
      participantId,
      new Date().toISOString()
    )
  } else if (participantRow.final_completed_at) {
    res.status(409).json({
      error:
        'This participant has already completed the final experiment and cannot participate again.',
    })
    return
  }

  if (runType === 'practice' && !config.practiceEnabled) {
    res.status(400).json({ error: 'Practice run is currently disabled.' })
    return
  }

  const numArms = config.numArms
  const rounds = runType === 'practice' ? config.practiceRounds : config.finalRounds
  const abGroup = chooseGroup(config)
  const visibilityMode = getVisibilityMode(config, abGroup)

  if (!Number.isInteger(numArms) || numArms < 2 || numArms > 20) {
    res.status(400).json({ error: 'numArms must be an integer between 2 and 20.' })
    return
  }

  if (!Number.isInteger(rounds) || rounds < 5 || rounds > 500) {
    res.status(400).json({ error: 'rounds must be an integer between 5 and 500.' })
    return
  }

  if (!['none', 'last-3', 'full', 'summary'].includes(visibilityMode)) {
    res.status(400).json({ error: 'visibilityMode must be one of: none, last-3, full, summary.' })
    return
  }

  const configuredMeans = config.armProbabilities.map((value) => Number(value.toFixed(4)))
  const banditMeans =
    configuredMeans.length === numArms
      ? configuredMeans
      : Array.from({ length: numArms }, () => randomMean())
  const id = createId('session')
  const createdAt = new Date().toISOString()

  const settings: SessionSettings = { numArms, rounds, visibilityMode }

  insertSession.run({
    id,
    created_at: createdAt,
    participant_id: participantId,
    run_type: runType,
    ab_group: abGroup,
    settings_json: JSON.stringify(settings),
    bandit_means_json: JSON.stringify(banditMeans),
  })

  res.json({
    sessionId: id,
    settings,
    banditMeans,
    runType,
    abGroup,
  })
})

app.post('/api/sessions/:sessionId/complete', (req, res) => {
  const sessionId = String(req.params.sessionId)
  const payload = req.body as CompletionPayload

  const hasPulls = Array.isArray(payload?.pulls) && payload.pulls.length > 0
  const hasQuestionnaire =
    payload?.questionnaire &&
    Number.isInteger(payload.questionnaire.targetArm) &&
    Array.isArray(payload.questionnaire.recalledSequence) &&
    Number.isFinite(payload.questionnaire.perceivedAverage)

  const hasMetrics = payload?.metrics && Number.isFinite(payload.metrics.totalReward)

  if (!hasPulls || !hasQuestionnaire || !hasMetrics) {
    res.status(400).json({ error: 'Missing pulls, questionnaire, or metrics payload.' })
    return
  }

  const sessionRow = db
    .prepare('SELECT id FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string } | undefined

  if (!sessionRow) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  const settingsRow = db
    .prepare('SELECT settings_json, run_type, participant_id FROM sessions WHERE id = ?')
    .get(sessionId) as
    | { settings_json: string; run_type: RunType; participant_id: string | null }
    | undefined

  if (!settingsRow) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  const settings = parseSessionSettings(settingsRow)

  if (payload.runType !== settingsRow.run_type) {
    res.status(400).json({ error: 'runType mismatch for session.' })
    return
  }

  if (payload.pulls.length !== settings.rounds) {
    res.status(400).json({ error: 'pull count does not match configured rounds.' })
    return
  }

  const now = new Date().toISOString()
  const targetArmHistory = payload.pulls
    .filter((pull) => pull.armIndex === payload.questionnaire.targetArm)
    .map((pull) => pull.reward)
    .reverse()

  const saveTransaction = db.transaction(() => {
    const deleteExisting = db.prepare('DELETE FROM pulls WHERE session_id = ?')
    deleteExisting.run(sessionId)

    for (const pull of payload.pulls) {
      insertPull.run({
        session_id: sessionId,
        round_index: pull.roundIndex,
        arm_index: pull.armIndex,
        reward: pull.reward,
        created_at: now,
      })
    }

    db.prepare('DELETE FROM questionnaires WHERE session_id = ?').run(sessionId)
    insertQuestionnaire.run({
      session_id: sessionId,
      target_arm: payload.questionnaire.targetArm,
      recalled_sequence_json: JSON.stringify(payload.questionnaire.recalledSequence),
      perceived_average: payload.questionnaire.perceivedAverage,
      created_at: now,
    })

    db.prepare('DELETE FROM memory_recall_items WHERE session_id = ?').run(sessionId)
    payload.questionnaire.recalledSequence.forEach((recalledReward, positionIndex) => {
      const actualReward =
        positionIndex < targetArmHistory.length ? targetArmHistory[positionIndex] : null
      const isMatch = actualReward !== null && actualReward === recalledReward ? 1 : 0

      insertMemoryRecallItem.run({
        session_id: sessionId,
        position_index: positionIndex,
        recalled_reward: recalledReward,
        actual_reward: actualReward,
        is_match: isMatch,
        recency_weight: 1 / (positionIndex + 1),
        created_at: now,
      })
    })

    db.prepare('DELETE FROM metrics WHERE session_id = ?').run(sessionId)
    insertMetrics.run({
      session_id: sessionId,
      total_reward: payload.metrics.totalReward,
      average_reward: payload.metrics.averageReward,
      best_arm_index: payload.metrics.bestArmIndex,
      best_arm_mean: payload.metrics.bestArmMean,
      expected_regret: payload.metrics.expectedRegret,
      recency_weighted_accuracy: payload.metrics.recencyWeightedAccuracy,
      perceived_average_error: payload.metrics.perceivedAverageError,
      metrics_json: JSON.stringify(payload.metrics),
      created_at: now,
    })

    upsertSessionHistory.run({
      session_id: sessionId,
      participant_id: settingsRow.participant_id,
      snapshot_json: JSON.stringify({
        sessionId,
        participantId: settingsRow.participant_id,
        createdAt: now,
        runType: settingsRow.run_type,
        settings,
        pulls: payload.pulls,
        questionnaire: {
          ...payload.questionnaire,
          actualTargetArmSequence: targetArmHistory,
        },
        metrics: payload.metrics,
      }),
      created_at: now,
    })

    if (settingsRow.run_type === 'final' && settingsRow.participant_id) {
      db.prepare('UPDATE participants SET final_completed_at = ? WHERE participant_id = ?').run(
        now,
        settingsRow.participant_id
      )
    }
  })

  saveTransaction()

  res.json({ ok: true, sessionId })
})

app.listen(port, () => {
  console.log(`Bandit API running on http://localhost:${port}`)
})
