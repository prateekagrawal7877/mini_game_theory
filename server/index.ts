import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { ensureDbInitialized, query, withTransaction } from './db.js'
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'

type VisibilityMode = 'none' | 'last-3' | 'full' | 'summary'

type SessionSettings = {
  experimentId: string
  experimentLabel: string
  numArms: number
  rounds: number
  visibilityMode: VisibilityMode
  exitAllowed: boolean
  showRoundHistory: boolean
  showArmPullCounts: boolean
  showCurrentArmProbabilities: boolean
  showGroupInstruction: boolean
  groupInstruction: string
}

type ABGroup = 'A' | 'B'

type RunType = 'practice' | 'final'

type ExperimentDefinition = {
  id: string
  label: string
  enabled: boolean
  numArms: number
  armProbabilities: number[]
  finalRounds: number
}

type PracticeConfig = {
  numArms: number
  armProbabilities: number[]
  rounds: number
}

type ExperimentConfig = {
  title: string
  purpose: string
  instructions: string
  exitAllowed: boolean
  maxFinalExperimentsPerParticipant: number
  experiments: ExperimentDefinition[]
  practiceEnabled: boolean
  practiceConfig: PracticeConfig
  abTestingEnabled: boolean
  defaultVisibilityMode: VisibilityMode
  groupConfigs: {
    A: {
      visibilityMode: VisibilityMode
      showRoundHistory: boolean
      showArmPullCounts: boolean
      showCurrentArmProbabilities: boolean
      showCustomInstruction: boolean
      customInstruction: string
    }
    B: {
      visibilityMode: VisibilityMode
      showRoundHistory: boolean
      showArmPullCounts: boolean
      showCurrentArmProbabilities: boolean
      showCustomInstruction: boolean
      customInstruction: string
    }
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
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const isProduction = process.env.NODE_ENV === 'production'
const enableTestAccount = String(process.env.ENABLE_TEST_ACCOUNT ?? (!isProduction)) === 'true'

const TEST_PARTICIPANT_ID = 'prateek@kriti'
const TEST_OTP = '123456'
const OTP_TTL_MS = 10 * 60 * 1000
const LOGIN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

function createOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

async function createLoginToken(participantId: string): Promise<string> {
  const token = createId('login')
  const nowIso = new Date().toISOString()
  const expiresAt = Date.now() + LOGIN_TOKEN_TTL_MS
  await query(
    'INSERT INTO auth_login_tokens (token, participant_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    [token, participantId, expiresAt, nowIso]
  )
  return token
}

async function isValidLoginToken(token: string, participantId: string): Promise<boolean> {
  await query('DELETE FROM auth_login_tokens WHERE expires_at < $1', [Date.now()])

  const result = await query<{ participant_id: string; expires_at: string | number }>(
    'SELECT participant_id, expires_at FROM auth_login_tokens WHERE token = $1',
    [token]
  )
  const row = result.rows[0]

  if (!row) {
    return false
  }

  const expiresAt = Number(row.expires_at)
  if (expiresAt < Date.now()) {
    await query('DELETE FROM auth_login_tokens WHERE token = $1', [token])
    return false
  }

  return row.participant_id === participantId
}

const otpSenderEmail = process.env.OTP_SENDER_EMAIL ?? ''
const otpSenderPassword = process.env.OTP_SENDER_PASSWORD ?? ''
const allowOtpDeliveryFallback =
  String(process.env.ALLOW_OTP_DELIVERY_FALLBACK ?? (process.env.NODE_ENV !== 'production')) ===
  'true'

const missingProductionEnv: string[] = []
if (isProduction) {
  if (!adminPassword || adminPassword === 'change-me-now') {
    missingProductionEnv.push('ADMIN_PASSWORD')
  }
  if (!otpSenderEmail) {
    missingProductionEnv.push('OTP_SENDER_EMAIL')
  }
  if (!otpSenderPassword) {
    missingProductionEnv.push('OTP_SENDER_PASSWORD')
  }
}

if (missingProductionEnv.length > 0) {
  throw new Error(
    `Missing production environment variables: ${missingProductionEnv.join(', ')}.`
  )
}

const otpTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: otpSenderEmail,
    pass: otpSenderPassword,
  },
})

async function sendOtpEmail(recipientEmail: string, otp: string): Promise<void> {
  await otpTransporter.sendMail({
    from: otpSenderEmail,
    to: recipientEmail,
    subject: 'Your Experiment OTP Code',
    text: `Your OTP code is ${otp}. It expires in 10 minutes.`,
  })
}

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use(async (_req, res, next) => {
  try {
    await ensureDbInitialized()
    next()
  } catch (error) {
    next(error)
  }
})

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

function normalizeExperimentDefinitions(raw: unknown): ExperimentDefinition[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map((value, index) => {
      const candidate = value as Partial<ExperimentDefinition> & { [key: string]: unknown }
      const numArmsRaw = Number(candidate.numArms ?? 2)
      const numArms =
        Number.isInteger(numArmsRaw) && numArmsRaw >= 2 && numArmsRaw <= 20 ? numArmsRaw : 2
      const finalRoundsRaw = Number(candidate.finalRounds ?? 30)
      const finalRounds =
        Number.isInteger(finalRoundsRaw) && finalRoundsRaw >= 5 && finalRoundsRaw <= 500
          ? finalRoundsRaw
          : 30

      return {
        id: String(candidate.id ?? `exp_${index + 1}`).trim() || `exp_${index + 1}`,
        label:
          String(candidate.label ?? `Experiment ${index + 1}`).trim() || `Experiment ${index + 1}`,
        enabled: Boolean(candidate.enabled ?? true),
        numArms,
        armProbabilities: normalizeArmProbabilities(candidate.armProbabilities, numArms),
        finalRounds,
      }
    })
    .filter((experiment) => experiment.id.length > 0)
}

function normalizePracticeConfig(raw: unknown): PracticeConfig {
  const candidate = (raw ?? {}) as Partial<PracticeConfig> & { [key: string]: unknown }
  const numArmsRaw = Number(candidate.numArms ?? 2)
  const numArms = Number.isInteger(numArmsRaw) && numArmsRaw >= 2 && numArmsRaw <= 20 ? numArmsRaw : 2
  const roundsRaw = Number(candidate.rounds ?? 10)
  const rounds = Number.isInteger(roundsRaw) && roundsRaw >= 3 && roundsRaw <= 200 ? roundsRaw : 10

  return {
    numArms,
    armProbabilities: normalizeArmProbabilities(candidate.armProbabilities, numArms),
    rounds,
  }
}

async function getExperimentConfig(): Promise<ExperimentConfig> {
  const result = await query<{ config_json: string }>(
    'SELECT config_json FROM experiment_config WHERE id = 1'
  )
  const row = result.rows[0]

  if (!row) {
    throw new Error('Experiment config missing')
  }

  const raw = JSON.parse(row.config_json) as Partial<ExperimentConfig> & {
    [key: string]: unknown
  }

  const numArms = Number(raw.numArms ?? 2)
  const normalizedNumArms = Number.isInteger(numArms) && numArms >= 2 && numArms <= 20 ? numArms : 2
  const normalizedExperiments = normalizeExperimentDefinitions(raw.experiments)
  const maxFinalRaw = Number(raw.maxFinalExperimentsPerParticipant ?? 1)
  const maxFinalExperimentsPerParticipant =
    Number.isInteger(maxFinalRaw) && maxFinalRaw >= 1 && maxFinalRaw <= 50 ? maxFinalRaw : 1
  const fallbackExperiment: ExperimentDefinition = {
    id: 'exp_1',
    label: 'Experiment 1',
    enabled: true,
    numArms: normalizedNumArms,
    armProbabilities: normalizeArmProbabilities(raw.armProbabilities, normalizedNumArms),
    finalRounds: Number(raw.finalRounds ?? 30),
  }

  return {
    title: String(raw.title ?? 'Bandit Decision-Making Study'),
    purpose: String(
      raw.purpose ??
        'This experiment studies how people learn from feedback under uncertainty and how different information views affect decision quality over repeated rounds.'
    ),
    instructions: String(
      raw.instructions ??
        'Your aim is to maximize total reward by selecting one arm per round. Rewards are binary (0 or 1). Some arms are better than others, so use feedback from earlier rounds to improve your choices.'
    ),
    exitAllowed: Boolean(raw.exitAllowed ?? true),
    maxFinalExperimentsPerParticipant,
    experiments: normalizedExperiments.length > 0 ? normalizedExperiments : [fallbackExperiment],
    practiceEnabled: Boolean(raw.practiceEnabled ?? true),
    practiceConfig: normalizePracticeConfig(raw.practiceConfig),
    abTestingEnabled: Boolean(raw.abTestingEnabled ?? true),
    defaultVisibilityMode: (raw.defaultVisibilityMode as VisibilityMode) ?? 'none',
    groupConfigs: {
      A: {
        visibilityMode: (raw.groupConfigs?.A?.visibilityMode as VisibilityMode) ?? 'none',
        showRoundHistory: Boolean(raw.groupConfigs?.A?.showRoundHistory ?? false),
        showArmPullCounts: Boolean(raw.groupConfigs?.A?.showArmPullCounts ?? false),
        showCurrentArmProbabilities: Boolean(
          raw.groupConfigs?.A?.showCurrentArmProbabilities ?? false
        ),
        showCustomInstruction: Boolean(raw.groupConfigs?.A?.showCustomInstruction ?? true),
        customInstruction: String(
          raw.groupConfigs?.A?.customInstruction ??
            'Group A condition: minimal feedback view. Focus on learning from immediate outcomes and strategy over time to maximize reward.'
        ),
      },
      B: {
        visibilityMode: (raw.groupConfigs?.B?.visibilityMode as VisibilityMode) ?? 'full',
        showRoundHistory: Boolean(raw.groupConfigs?.B?.showRoundHistory ?? true),
        showArmPullCounts: Boolean(raw.groupConfigs?.B?.showArmPullCounts ?? true),
        showCurrentArmProbabilities: Boolean(
          raw.groupConfigs?.B?.showCurrentArmProbabilities ?? true
        ),
        showCustomInstruction: Boolean(raw.groupConfigs?.B?.showCustomInstruction ?? true),
        customInstruction: String(
          raw.groupConfigs?.B?.customInstruction ??
            'Group B condition: full feedback view. Use round history, pull counts, and displayed reward probabilities to optimize your selections.'
        ),
      },
    },
  }
}

async function saveExperimentConfig(config: ExperimentConfig): Promise<void> {
  await query('UPDATE experiment_config SET config_json = $1, updated_at = $2 WHERE id = 1', [
    JSON.stringify(config),
    new Date().toISOString(),
  ])
}

function secureRandom01(): number {
  const value = crypto.randomBytes(4).readUInt32BE(0)
  return value / 0x100000000
}

async function chooseBalancedGroup(config: ExperimentConfig): Promise<ABGroup> {
  if (!config.abTestingEnabled) {
    return 'A'
  }

  const result = await query<{ count_a: string | number | null; count_b: string | number | null }>(
    `SELECT
       SUM(CASE WHEN ab_group = 'A' THEN 1 ELSE 0 END) AS count_a,
       SUM(CASE WHEN ab_group = 'B' THEN 1 ELSE 0 END) AS count_b
     FROM participants`
  )
  const counts = result.rows[0] ?? { count_a: 0, count_b: 0 }

  const countA = Number(counts.count_a ?? 0)
  const countB = Number(counts.count_b ?? 0)

  // Strict balancing: always place the next participant in the smaller group.
  // Random tie-break keeps assignment unbiased when counts are equal.
  if (countA === countB) {
    return secureRandom01() < 0.5 ? 'A' : 'B'
  }

  return countA < countB ? 'A' : 'B'
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
  if (typeof config.exitAllowed !== 'boolean') {
    return 'exitAllowed must be boolean'
  }
  if (
    !Number.isInteger(config.maxFinalExperimentsPerParticipant) ||
    config.maxFinalExperimentsPerParticipant < 1 ||
    config.maxFinalExperimentsPerParticipant > 50
  ) {
    return 'maxFinalExperimentsPerParticipant must be an integer between 1 and 50'
  }
  if (!Array.isArray(config.experiments) || config.experiments.length === 0) {
    return 'At least one experiment configuration is required'
  }

  const experimentIds = new Set<string>()
  for (let i = 0; i < config.experiments.length; i += 1) {
    const experiment = config.experiments[i]
    const prefix = `experiments[${i}]`

    if (!experiment.id?.trim()) {
      return `${prefix}.id is required`
    }
    if (experimentIds.has(experiment.id)) {
      return `Duplicate experiment id detected: ${experiment.id}`
    }
    experimentIds.add(experiment.id)

    if (!experiment.label?.trim()) {
      return `${prefix}.label is required`
    }
    if (!Number.isInteger(experiment.numArms) || experiment.numArms < 2 || experiment.numArms > 20) {
      return `${prefix}.numArms must be an integer between 2 and 20`
    }
    if (
      !Array.isArray(experiment.armProbabilities) ||
      experiment.armProbabilities.length !== experiment.numArms
    ) {
      return `${prefix}.armProbabilities must contain exactly one value per arm`
    }
    if (
      experiment.armProbabilities.some(
        (value) => !Number.isFinite(value) || value < 0 || value > 1
      )
    ) {
      return `${prefix}.armProbabilities values must be between 0 and 1`
    }
    if (!Number.isInteger(experiment.finalRounds) || experiment.finalRounds < 5 || experiment.finalRounds > 500) {
      return `${prefix}.finalRounds must be an integer between 5 and 500`
    }
  }
  if (!Number.isInteger(config.practiceConfig?.numArms) || config.practiceConfig.numArms < 2 || config.practiceConfig.numArms > 20) {
    return 'practiceConfig.numArms must be an integer between 2 and 20'
  }
  if (
    !Array.isArray(config.practiceConfig?.armProbabilities) ||
    config.practiceConfig.armProbabilities.length !== config.practiceConfig.numArms
  ) {
    return 'practiceConfig.armProbabilities must contain exactly one value per arm'
  }
  if (
    config.practiceConfig.armProbabilities.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1
    )
  ) {
    return 'practiceConfig.armProbabilities values must be between 0 and 1'
  }
  if (!Number.isInteger(config.practiceConfig?.rounds) || config.practiceConfig.rounds < 3 || config.practiceConfig.rounds > 200) {
    return 'practiceConfig.rounds must be an integer between 3 and 200'
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
  if (typeof config.groupConfigs?.A?.showRoundHistory !== 'boolean') {
    return 'groupConfigs.A.showRoundHistory must be boolean'
  }
  if (typeof config.groupConfigs?.B?.showRoundHistory !== 'boolean') {
    return 'groupConfigs.B.showRoundHistory must be boolean'
  }
  if (typeof config.groupConfigs?.A?.showArmPullCounts !== 'boolean') {
    return 'groupConfigs.A.showArmPullCounts must be boolean'
  }
  if (typeof config.groupConfigs?.B?.showArmPullCounts !== 'boolean') {
    return 'groupConfigs.B.showArmPullCounts must be boolean'
  }
  if (typeof config.groupConfigs?.A?.showCurrentArmProbabilities !== 'boolean') {
    return 'groupConfigs.A.showCurrentArmProbabilities must be boolean'
  }
  if (typeof config.groupConfigs?.B?.showCurrentArmProbabilities !== 'boolean') {
    return 'groupConfigs.B.showCurrentArmProbabilities must be boolean'
  }
  if (typeof config.groupConfigs?.A?.showCustomInstruction !== 'boolean') {
    return 'groupConfigs.A.showCustomInstruction must be boolean'
  }
  if (typeof config.groupConfigs?.B?.showCustomInstruction !== 'boolean') {
    return 'groupConfigs.B.showCustomInstruction must be boolean'
  }
  if (typeof config.groupConfigs?.A?.customInstruction !== 'string') {
    return 'groupConfigs.A.customInstruction must be a string'
  }
  if (typeof config.groupConfigs?.B?.customInstruction !== 'string') {
    return 'groupConfigs.B.customInstruction must be a string'
  }
  return null
}

async function requireAdminToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const token = String(req.header('x-admin-token') ?? '')

  if (!token) {
    res.status(401).json({ error: 'Unauthorized admin access.' })
    return
  }

  await query('DELETE FROM admin_auth_tokens WHERE expires_at < $1', [Date.now()])
  const result = await query<{ token: string; expires_at: string | number }>(
    'SELECT token, expires_at FROM admin_auth_tokens WHERE token = $1',
    [token]
  )
  const row = result.rows[0]

  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) {
      await query('DELETE FROM admin_auth_tokens WHERE token = $1', [token])
    }
    res.status(401).json({ error: 'Unauthorized admin access.' })
    return
  }

  next()
}

function parseSessionSettings(sessionRow: { settings_json: string }): SessionSettings {
  return JSON.parse(sessionRow.settings_json) as SessionSettings
}

function pickExperiment(config: ExperimentConfig, experimentId: string): ExperimentDefinition | null {
  const enabledExperiments = config.experiments.filter((experiment) => experiment.enabled)

  if (enabledExperiments.length === 0) {
    return null
  }

  const selected = enabledExperiments.find((experiment) => experiment.id === experimentId)
  return selected ?? enabledExperiments[0]
}

async function resolveParticipantGroup(
  config: ExperimentConfig,
  participantId: string
): Promise<ABGroup> {
  const rowResult = await query<{ participant_id: string; ab_group: string | null }>(
    'SELECT participant_id, ab_group FROM participants WHERE participant_id = $1',
    [participantId]
  )
  const row = rowResult.rows[0]

  if (!row) {
    const group = await chooseBalancedGroup(config)
    await query(
      'INSERT INTO participants (participant_id, created_at, ab_group, final_completed_at) VALUES ($1, $2, $3, NULL)',
      [participantId, new Date().toISOString(), group]
    )
    return group
  }

  if (row.ab_group === 'A' || row.ab_group === 'B') {
    return row.ab_group
  }

  const group = await chooseBalancedGroup(config)
  await query('UPDATE participants SET ab_group = $1 WHERE participant_id = $2', [
    group,
    participantId,
  ])
  return group
}

async function deleteSessionData(sessionId: string): Promise<void> {
  await withTransaction(async (client) => {
    const sessionMetaResult = await query<{
      participant_id: string | null
      experiment_id: string | null
      run_type: RunType
    }>('SELECT participant_id, experiment_id, run_type FROM sessions WHERE id = $1', [sessionId], client)
    const sessionMeta = sessionMetaResult.rows[0]

    if (sessionMeta?.run_type === 'final' && sessionMeta.participant_id && sessionMeta.experiment_id) {
      await query(
        'DELETE FROM participant_experiments WHERE participant_id = $1 AND experiment_id = $2 AND final_session_id = $3',
        [sessionMeta.participant_id, sessionMeta.experiment_id, sessionId],
        client
      )
    }

    await query('DELETE FROM pulls WHERE session_id = $1', [sessionId], client)
    await query('DELETE FROM questionnaires WHERE session_id = $1', [sessionId], client)
    await query('DELETE FROM memory_recall_items WHERE session_id = $1', [sessionId], client)
    await query('DELETE FROM metrics WHERE session_id = $1', [sessionId], client)
    await query('DELETE FROM session_history WHERE session_id = $1', [sessionId], client)
    await query('DELETE FROM sessions WHERE id = $1', [sessionId], client)
  })
}

function normalizeParticipantId(input: unknown): string {
  return String(input ?? '').trim().toLowerCase()
}

function isValidParticipantId(participantId: string): boolean {
  if (enableTestAccount && participantId === TEST_PARTICIPANT_ID) {
    return true
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participantId)
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? '')
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

type ExportPullRow = {
  session_id: string
  session_created_at: string
  participant_id: string | null
  run_type: string
  ab_group: string
  experiment_id: string | null
  settings_json: string
  bandit_means_json: string
  round_index: number
  arm_index: number
  reward: number
  pull_created_at: string
}

function buildPullHistoryCsv(rows: ExportPullRow[]): string {
  const headers = [
    'session_id',
    'session_created_at',
    'participant_id',
    'run_type',
    'ab_group',
    'experiment_id',
    'experiment_label',
    'num_arms',
    'rounds',
    'visibility_mode',
    'show_round_history',
    'show_arm_pull_counts',
    'show_current_arm_probabilities',
    'configured_arm_probabilities',
    'pull_round_index',
    'pull_arm_index',
    'pull_reward',
    'pull_created_at',
  ]

  const lines = [headers.join(',')]

  for (const row of rows) {
    const settings = JSON.parse(row.settings_json) as SessionSettings
    const configuredArmProbabilities = JSON.parse(row.bandit_means_json) as number[]

    const line = [
      row.session_id,
      row.session_created_at,
      row.participant_id ?? '',
      row.run_type,
      row.ab_group,
      row.experiment_id ?? '',
      settings.experimentLabel,
      settings.numArms,
      settings.rounds,
      settings.visibilityMode,
      settings.showRoundHistory,
      settings.showArmPullCounts,
      settings.showCurrentArmProbabilities,
      configuredArmProbabilities.join('|'),
      row.round_index,
      row.arm_index,
      row.reward,
      row.pull_created_at,
    ].map(escapeCsvCell)

    lines.push(line.join(','))
  }

  return lines.join('\n')
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/admin/login', async (req, res) => {
  const providedPassword = String(req.body?.password ?? '')

  if (!providedPassword || providedPassword !== adminPassword) {
    res.status(401).json({ error: 'Invalid admin password.' })
    return
  }

  const token = crypto.randomBytes(24).toString('hex')
  await query('DELETE FROM admin_auth_tokens WHERE expires_at < $1', [Date.now()])
  await query('INSERT INTO admin_auth_tokens (token, expires_at, created_at) VALUES ($1, $2, $3)', [
    token,
    Date.now() + ADMIN_TOKEN_TTL_MS,
    new Date().toISOString(),
  ])

  res.json({ token })
})

app.get('/api/admin/experiment', requireAdminToken, async (_req, res) => {
  const config = await getExperimentConfig()
  res.json({ config })
})

app.put('/api/admin/experiment', requireAdminToken, async (req, res) => {
  const proposedConfig = req.body?.config as ExperimentConfig
  const validationError = validateExperimentConfig(proposedConfig)

  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  await saveExperimentConfig(proposedConfig)
  res.json({ ok: true, config: proposedConfig })
})

app.get('/api/admin/sessions', requireAdminToken, async (_req, res) => {
  const rowsResult = await query<Record<string, unknown>>(
    `SELECT
       s.id,
       s.created_at,
       s.participant_id,
       s.experiment_id,
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

  res.json({ rows: rowsResult.rows })
})

app.get('/api/admin/export/group/:group', requireAdminToken, async (req, res) => {
  const group = String(req.params.group).toUpperCase()
  if (group !== 'A' && group !== 'B') {
    res.status(400).json({ error: 'group must be A or B' })
    return
  }

  const rowsResult = await query<ExportPullRow>(
    `SELECT
       s.id AS session_id,
       s.created_at AS session_created_at,
       s.participant_id,
       s.run_type,
       s.ab_group,
       s.experiment_id,
       s.settings_json,
       s.bandit_means_json,
       p.round_index,
       p.arm_index,
       p.reward,
       p.created_at AS pull_created_at
     FROM sessions s
     INNER JOIN pulls p ON p.session_id = s.id
     WHERE s.ab_group = $1
     ORDER BY s.created_at ASC, p.round_index ASC`,
    [group]
  )

  const csv = buildPullHistoryCsv(rowsResult.rows)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="group_${group}_pull_history.csv"`)
  res.send(csv)
})

app.get('/api/admin/export/experiment/:experimentId', requireAdminToken, async (req, res) => {
  const experimentId = String(req.params.experimentId)

  const rowsResult = await query<ExportPullRow>(
    `SELECT
       s.id AS session_id,
       s.created_at AS session_created_at,
       s.participant_id,
       s.run_type,
       s.ab_group,
       s.experiment_id,
       s.settings_json,
       s.bandit_means_json,
       p.round_index,
       p.arm_index,
       p.reward,
       p.created_at AS pull_created_at
     FROM sessions s
     INNER JOIN pulls p ON p.session_id = s.id
     WHERE s.experiment_id = $1
       AND s.run_type = 'final'
     ORDER BY s.created_at ASC, p.round_index ASC`,
    [experimentId]
  )

  const csv = buildPullHistoryCsv(rowsResult.rows)
  const safeExperimentId = experimentId.replace(/[^a-zA-Z0-9_-]/g, '_')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="experiment_${safeExperimentId}_pull_history.csv"`
  )
  res.send(csv)
})

app.delete('/api/admin/history/:sessionId', requireAdminToken, async (req, res) => {
  const sessionId = String(req.params.sessionId)
  const existsResult = await query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [
    sessionId,
  ])
  const exists = existsResult.rows[0]

  if (!exists) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  await deleteSessionData(sessionId)

  res.json({ ok: true, deletedSessionId: sessionId })
})

app.delete('/api/admin/history', requireAdminToken, async (_req, res) => {
  await withTransaction(async (client) => {
    await query('DELETE FROM pulls', [], client)
    await query('DELETE FROM questionnaires', [], client)
    await query('DELETE FROM memory_recall_items', [], client)
    await query('DELETE FROM metrics', [], client)
    await query('DELETE FROM session_history', [], client)
    await query('DELETE FROM participant_experiments', [], client)
    await query('DELETE FROM sessions', [], client)
    await query('DELETE FROM participants', [], client)
    await query('DELETE FROM auth_otp_codes', [], client)
    await query('DELETE FROM auth_login_tokens', [], client)
  })

  res.json({ ok: true })
})

app.get('/api/participant/experiment', async (_req, res) => {
  const config = await getExperimentConfig()

  res.json({
    title: config.title,
    purpose: config.purpose,
    instructions: config.instructions,
    practiceEnabled: config.practiceEnabled,
    practiceConfig: config.practiceConfig,
    maxFinalExperimentsPerParticipant: config.maxFinalExperimentsPerParticipant,
    experiments: config.experiments.filter((experiment) => experiment.enabled),
    groupDisplayDefaults: {
      A: {
        showRoundHistory: config.groupConfigs.A.showRoundHistory,
        showArmPullCounts: config.groupConfigs.A.showArmPullCounts,
        showCurrentArmProbabilities: config.groupConfigs.A.showCurrentArmProbabilities,
      },
      B: {
        showRoundHistory: config.groupConfigs.B.showRoundHistory,
        showArmPullCounts: config.groupConfigs.B.showArmPullCounts,
        showCurrentArmProbabilities: config.groupConfigs.B.showCurrentArmProbabilities,
      },
    },
  })
})

app.post('/api/auth/request-otp', async (req, res) => {
  const participantId = normalizeParticipantId(req.body?.email)
  const isTester = enableTestAccount && participantId === TEST_PARTICIPANT_ID

  if (!participantId || !isValidParticipantId(participantId)) {
    res.status(400).json({ error: 'Enter a valid email address.' })
    return
  }

  await query('DELETE FROM auth_otp_codes WHERE expires_at < $1', [Date.now()])

  const otp = isTester ? TEST_OTP : createOtpCode()
  await query(
    `INSERT INTO auth_otp_codes (email, otp, expires_at, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(email) DO UPDATE SET
       otp = excluded.otp,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
    [participantId, otp, Date.now() + OTP_TTL_MS, new Date().toISOString()]
  )

  try {
    if (!isTester) {
      await sendOtpEmail(participantId, otp)
    }
  } catch (error) {
    console.error('OTP email delivery failed:', error)
    if (!allowOtpDeliveryFallback) {
      res.status(500).json({
        error:
          'Failed to send OTP email. Configure OTP sender credentials (prefer Gmail app password) and try again.',
      })
      return
    }

    res.json({
      ok: true,
      warning: 'Email delivery failed in fallback mode.',
    })
    return
  }

  res.json({ ok: true })
})

app.post('/api/auth/verify-otp', async (req, res) => {
  const participantId = normalizeParticipantId(req.body?.email)
  const otp = String(req.body?.otp ?? '').trim()

  if (!participantId || !isValidParticipantId(participantId)) {
    res.status(400).json({ error: 'Enter a valid email address.' })
    return
  }

  await query('DELETE FROM auth_otp_codes WHERE expires_at < $1', [Date.now()])

  const pendingResult = await query<{ otp: string; expires_at: string | number }>(
    'SELECT otp, expires_at FROM auth_otp_codes WHERE email = $1',
    [participantId]
  )
  const pending = pendingResult.rows[0]

  if (!pending || Number(pending.expires_at) < Date.now()) {
    await query('DELETE FROM auth_otp_codes WHERE email = $1', [participantId])
    res.status(401).json({ error: 'OTP expired or not requested. Please request a new OTP.' })
    return
  }

  if (pending.otp !== otp) {
    res.status(401).json({ error: 'Invalid OTP.' })
    return
  }

  await query('DELETE FROM auth_otp_codes WHERE email = $1', [participantId])
  const loginToken = await createLoginToken(participantId)

  res.json({ ok: true, participantId, loginToken })
})

app.post('/api/sessions/start', async (req, res) => {
  const participantId = normalizeParticipantId(req.body?.participantId)
  const loginToken = String(req.body?.loginToken ?? '').trim()
  const requestedExperimentId = String(req.body?.experimentId ?? '').trim()
  const requestedRunType = String(req.body?.runType ?? 'final')
  const runType: RunType = requestedRunType === 'practice' ? 'practice' : 'final'

  if (!participantId) {
    res.status(400).json({
      error: 'Participant email is required.',
    })
    return
  }

  if (!isValidParticipantId(participantId)) {
    res.status(400).json({
      error: 'Invalid participant email format.',
    })
    return
  }

  if (!(await isValidLoginToken(loginToken, participantId))) {
    res.status(401).json({ error: 'Login verification required. Verify OTP before starting.' })
    return
  }

  const config = await getExperimentConfig()

  const enabledExperiments = config.experiments.filter((experiment) => experiment.enabled)
  let selectedExperiment =
    runType === 'practice' ? null : pickExperiment(config, requestedExperimentId)

  if (runType === 'final' && !selectedExperiment) {
    res.status(400).json({ error: 'No enabled experiments are available. Ask admin to enable one.' })
    return
  }

  if (runType === 'final' && requestedExperimentId && selectedExperiment && selectedExperiment.id !== requestedExperimentId) {
    res.status(400).json({ error: 'Selected experiment is not available for participation.' })
    return
  }

  if (runType === 'practice' && !config.practiceEnabled) {
    res.status(400).json({ error: 'Practice run is currently disabled.' })
    return
  }

  const abGroup = await resolveParticipantGroup(config, participantId)

  const isTester = enableTestAccount && participantId === TEST_PARTICIPANT_ID

  if (runType === 'final' && !isTester) {
    const enabledExperimentCount = config.experiments.filter((experiment) => experiment.enabled).length
    const effectiveFinalLimit = Math.max(config.maxFinalExperimentsPerParticipant, enabledExperimentCount)

    const completedFinalCountResult = await query<{ completed_count: string | number }>(
      'SELECT COUNT(*) AS completed_count FROM participant_experiments WHERE participant_id = $1 AND final_completed_at IS NOT NULL',
      [participantId]
    )
    const completedFinalCountRow = completedFinalCountResult.rows[0] ?? { completed_count: 0 }

    if (Number(completedFinalCountRow.completed_count) >= effectiveFinalLimit) {
      res.status(409).json({
        error:
          'This participant has reached the maximum allowed number of completed final experiments.',
      })
      return
    }

    const completedExperimentRows = await query<{ experiment_id: string | null }>(
      `SELECT experiment_id
       FROM participant_experiments
       WHERE participant_id = $1 AND final_completed_at IS NOT NULL`,
      [participantId]
    )
    const completedExperimentIds = new Set(
      completedExperimentRows.rows
        .map((row) => row.experiment_id)
        .filter((value): value is string => Boolean(value))
    )
    const remainingEnabledExperiments = enabledExperiments.filter(
      (experiment) => !completedExperimentIds.has(experiment.id)
    )

    if (remainingEnabledExperiments.length === 0) {
      res.status(409).json({
        error:
          'This participant has reached the maximum allowed number of completed final experiments.',
      })
      return
    }

    const existingFinalResult = await query<{ final_completed_at: string | null }>(
      'SELECT final_completed_at FROM participant_experiments WHERE participant_id = $1 AND experiment_id = $2',
      [participantId, selectedExperiment?.id ?? null]
    )
    const existingFinalForExperiment = existingFinalResult.rows[0]

    if (existingFinalForExperiment?.final_completed_at) {
      selectedExperiment = remainingEnabledExperiments[0]
    }
  }

  const numArms = runType === 'practice' ? config.practiceConfig.numArms : selectedExperiment?.numArms ?? 2
  const rounds = runType === 'practice' ? config.practiceConfig.rounds : selectedExperiment?.finalRounds ?? 30
  const visibilityMode = getVisibilityMode(config, abGroup)

  if (!Number.isInteger(numArms) || numArms < 2 || numArms > 20) {
    res.status(400).json({ error: 'numArms must be an integer between 2 and 20.' })
    return
  }

  const minRounds = runType === 'practice' ? 3 : 5
  const maxRounds = runType === 'practice' ? 200 : 500
  if (!Number.isInteger(rounds) || rounds < minRounds || rounds > maxRounds) {
    res.status(400).json({ error: `rounds must be an integer between ${minRounds} and ${maxRounds}.` })
    return
  }

  if (!['none', 'last-3', 'full', 'summary'].includes(visibilityMode)) {
    res.status(400).json({ error: 'visibilityMode must be one of: none, last-3, full, summary.' })
    return
  }

  const configuredMeans =
    runType === 'practice'
      ? config.practiceConfig.armProbabilities.map((value) => Number(value.toFixed(4)))
      : (selectedExperiment?.armProbabilities ?? []).map((value) => Number(value.toFixed(4)))
  const banditMeans =
    configuredMeans.length === numArms
      ? configuredMeans
      : Array.from({ length: numArms }, () => randomMean())
  const id = createId('session')
  const createdAt = new Date().toISOString()

  const settings: SessionSettings = {
    experimentId: runType === 'practice' ? 'practice' : selectedExperiment?.id ?? 'unknown',
    experimentLabel: runType === 'practice' ? 'Practice Trial' : selectedExperiment?.label ?? 'Experiment',
    numArms,
    rounds,
    visibilityMode,
    exitAllowed: config.exitAllowed,
    showRoundHistory: config.groupConfigs[abGroup].showRoundHistory,
    showArmPullCounts: config.groupConfigs[abGroup].showArmPullCounts,
    showCurrentArmProbabilities: config.groupConfigs[abGroup].showCurrentArmProbabilities,
    showGroupInstruction: config.groupConfigs[abGroup].showCustomInstruction,
    groupInstruction: config.groupConfigs[abGroup].customInstruction,
  }

  await query(
    `INSERT INTO sessions (
      id,
      created_at,
      participant_id,
      experiment_id,
      run_type,
      ab_group,
      settings_json,
      bandit_means_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      createdAt,
      participantId,
      runType === 'practice' ? 'practice' : selectedExperiment?.id ?? null,
      runType,
      abGroup,
      JSON.stringify(settings),
      JSON.stringify(banditMeans),
    ]
  )

  res.json({
    sessionId: id,
    settings,
    banditMeans,
    experiment: {
      id: runType === 'practice' ? 'practice' : selectedExperiment?.id ?? 'unknown',
      label: runType === 'practice' ? 'Practice Trial' : selectedExperiment?.label ?? 'Experiment',
    },
    runType,
    abGroup,
  })
})

app.post('/api/sessions/:sessionId/complete', async (req, res) => {
  const sessionId = String(req.params.sessionId)
  const payload = req.body as CompletionPayload

  const hasPulls = Array.isArray(payload?.pulls) && payload.pulls.length > 0
  const hasMetrics = payload?.metrics && Number.isFinite(payload.metrics.totalReward)

  if (!hasPulls || !hasMetrics) {
    res.status(400).json({ error: 'Missing pulls or metrics payload.' })
    return
  }

  const sessionRowResult = await query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [
    sessionId,
  ])
  const sessionRow = sessionRowResult.rows[0]

  if (!sessionRow) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  const settingsResult = await query<{
    settings_json: string
    run_type: RunType
    participant_id: string | null
    experiment_id: string | null
  }>('SELECT settings_json, run_type, participant_id, experiment_id FROM sessions WHERE id = $1', [sessionId])
  const settingsRow = settingsResult.rows[0]

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
  const roundIndexes = payload.pulls.map((pull) => pull.roundIndex)
  const armIndexes = payload.pulls.map((pull) => pull.armIndex)
  const rewards = payload.pulls.map((pull) => pull.reward)

  await withTransaction(async (client) => {
    await query('DELETE FROM pulls WHERE session_id = $1', [sessionId], client)

    await query(
      `INSERT INTO pulls (session_id, round_index, arm_index, reward, created_at)
       SELECT $1, pulls.round_index, pulls.arm_index, pulls.reward, $5
       FROM unnest($2::int[], $3::int[], $4::double precision[])
       AS pulls(round_index, arm_index, reward)`,
      [sessionId, roundIndexes, armIndexes, rewards, now],
      client
    )

    await query('DELETE FROM metrics WHERE session_id = $1', [sessionId], client)
    await query(
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        sessionId,
        payload.metrics.totalReward,
        payload.metrics.averageReward,
        payload.metrics.bestArmIndex,
        payload.metrics.bestArmMean,
        payload.metrics.expectedRegret,
        payload.metrics.recencyWeightedAccuracy,
        payload.metrics.perceivedAverageError,
        JSON.stringify(payload.metrics),
        now,
      ],
      client
    )

    await query(
      `INSERT INTO session_history (session_id, participant_id, snapshot_json, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(session_id) DO UPDATE SET
         participant_id = excluded.participant_id,
         snapshot_json = excluded.snapshot_json,
         created_at = excluded.created_at`,
      [
        sessionId,
        settingsRow.participant_id,
        JSON.stringify({
          sessionId,
          participantId: settingsRow.participant_id,
          createdAt: now,
          runType: settingsRow.run_type,
          settings,
          pulls: payload.pulls,
          metrics: payload.metrics,
        }),
        now,
      ],
      client
    )

    if (settingsRow.run_type === 'final' && settingsRow.participant_id && settingsRow.experiment_id) {
      await query(
        `INSERT INTO participant_experiments (
          participant_id,
          experiment_id,
          final_completed_at,
          final_session_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(participant_id, experiment_id) DO UPDATE SET
          final_completed_at = excluded.final_completed_at,
          final_session_id = excluded.final_session_id`,
        [settingsRow.participant_id, settingsRow.experiment_id, now, sessionId, now],
        client
      )

      await query(
        'UPDATE participants SET final_completed_at = $1 WHERE participant_id = $2',
        [now, settingsRow.participant_id],
        client
      )
    }
  })

  res.json({ ok: true, sessionId })
})

app.post('/api/sessions/:sessionId/abort', async (req, res) => {
  const sessionId = String(req.params.sessionId)
  const participantId = normalizeParticipantId(req.body?.participantId)

  const sessionResult = await query<{
    id: string
    participant_id: string | null
    settings_json: string
  }>('SELECT id, participant_id, settings_json FROM sessions WHERE id = $1', [sessionId])
  const sessionRow = sessionResult.rows[0]

  if (!sessionRow) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  if (participantId && sessionRow.participant_id && sessionRow.participant_id !== participantId) {
    res.status(403).json({ error: 'Session does not belong to this participant.' })
    return
  }

  const metricsResult = await query<{ id: number }>('SELECT id FROM metrics WHERE session_id = $1', [
    sessionId,
  ])
  const metricsRow = metricsResult.rows[0]

  if (metricsRow) {
    res.status(409).json({ error: 'Completed sessions cannot be aborted.' })
    return
  }

  const settings = parseSessionSettings({ settings_json: sessionRow.settings_json })
  if (!settings.exitAllowed) {
    res.status(403).json({ error: 'Exit is disabled for this experiment.' })
    return
  }

  await deleteSessionData(sessionId)

  res.json({ ok: true, abortedSessionId: sessionId })
})

if (!process.env.VERCEL) {
  ensureDbInitialized()
    .then(() => {
      app.listen(port, () => {
        console.log(`Bandit API running on http://localhost:${port}`)
      })
    })
    .catch((error) => {
      console.error('Failed to initialize database:', error)
      process.exit(1)
    })
}

export default app
