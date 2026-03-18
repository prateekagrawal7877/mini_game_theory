import { useEffect, useMemo, useRef, useState } from 'react'

type VisibilityMode = 'none' | 'last-3' | 'full' | 'summary'
type ABGroup = 'A' | 'B'
type RunType = 'practice' | 'final'
type AppMode = 'participant' | 'admin'

type ParticipantStage =
  | 'loading'
  | 'intro'
  | 'play'
  | 'questionnaire'
  | 'run-result'
  | 'final-complete'

type Pull = {
  roundIndex: number
  armIndex: number
  reward: number
}

type Metrics = {
  totalReward: number
  averageReward: number
  bestArmIndex: number
  bestArmMean: number
  expectedRegret: number
  recencyWeightedAccuracy: number | null
  perceivedAverageError: number | null
  uniqueArmsChosen: number
}

type ExperimentBrief = {
  title: string
  purpose: string
  instructions: string
  practiceEnabled: boolean
}

type SessionStartResponse = {
  sessionId: string
  settings: {
    numArms: number
    rounds: number
    visibilityMode: VisibilityMode
  }
  banditMeans: number[]
  runType: RunType
  abGroup: ABGroup
}

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

type AdminSessionRow = {
  id: string
  created_at: string
  participant_id: string | null
  run_type: string
  ab_group: string
  total_reward: number | null
  average_reward: number | null
  expected_regret: number | null
  recency_weighted_accuracy: number | null
  perceived_average_error: number | null
}

const visibilityLabels: Record<VisibilityMode, string> = {
  none: 'No pull history visible',
  'last-3': 'Only last 3 rewards per arm',
  full: 'Full reward history per arm',
  summary: 'Summary stats only (count/avg)',
}

function format(value: number): string {
  return value.toFixed(3)
}

function parseRecallInput(input: string): number[] {
  return input
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value))
}

function getMostPulledArmIndex(allPulls: Pull[], numArms: number): number {
  const counts = new Array<number>(numArms).fill(0)
  for (const pull of allPulls) {
    if (pull.armIndex >= 0 && pull.armIndex < numArms) {
      counts[pull.armIndex] += 1
    }
  }

  let bestIndex = 0
  let bestCount = counts[0] ?? 0
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] > bestCount) {
      bestCount = counts[i]
      bestIndex = i
    }
  }

  return bestIndex
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  const raw = await response.text()
  if (!raw.trim()) {
    return null
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function buildHttpErrorMessage(
  payload: { error?: string } | null,
  fallback: string,
  response: Response
): string {
  if (payload?.error) {
    return payload.error
  }

  return `${fallback} (HTTP ${response.status})`
}

function toUserErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (err.message === 'Failed to fetch') {
      return 'Cannot reach the server. Start with ./launch_website.sh and open http://localhost:5173.'
    }
    return err.message
  }

  return fallback
}

const PULL_REVEAL_MS = 1200
const ROUND_TRANSITION_MS = 550

function App() {
  const [mode, setMode] = useState<AppMode>('participant')

  const [participantStage, setParticipantStage] = useState<ParticipantStage>('loading')
  const [experimentBrief, setExperimentBrief] = useState<ExperimentBrief | null>(null)
  const [participantId, setParticipantId] = useState<string>('')

  const [numArms, setNumArms] = useState<number>(2)
  const [rounds, setRounds] = useState<number>(0)
  const [visibilityMode, setVisibilityMode] = useState<VisibilityMode>('last-3')
  const [abGroup, setAbGroup] = useState<ABGroup>('A')
  const [runType, setRunType] = useState<RunType>('final')

  const [sessionId, setSessionId] = useState<string>('')
  const [banditMeans, setBanditMeans] = useState<number[]>([])
  const [pulls, setPulls] = useState<Pull[]>([])
  const [questionTargetArm, setQuestionTargetArm] = useState<number>(0)
  const [recalledSequenceInput, setRecalledSequenceInput] = useState<string>('')
  const [perceivedAverageInput, setPerceivedAverageInput] = useState<string>('')
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState<string>('')
  const [saving, setSaving] = useState<boolean>(false)

  const [adminPasswordInput, setAdminPasswordInput] = useState<string>('')
  const [adminToken, setAdminToken] = useState<string>('')
  const [adminConfig, setAdminConfig] = useState<ExperimentConfig | null>(null)
  const [adminSessions, setAdminSessions] = useState<AdminSessionRow[]>([])
  const [adminMessage, setAdminMessage] = useState<string>('')
  const [pullInProgress, setPullInProgress] = useState<boolean>(false)
  const [activeArmIndex, setActiveArmIndex] = useState<number | null>(null)
  const [latestPullFeedback, setLatestPullFeedback] = useState<{
    armIndex: number
    reward: number
    roundNumber: number
  } | null>(null)

  const pullTimerRef = useRef<number | null>(null)
  const transitionTimerRef = useRef<number | null>(null)

  const currentRound = pulls.length
  const finished = currentRound >= rounds
  const totalRewardSoFar = useMemo(() => pulls.reduce((sum, pull) => sum + pull.reward, 0), [pulls])

  const pullsByArm = useMemo(() => {
    return Array.from({ length: numArms }, (_, armIndex) =>
      pulls.filter((pull) => pull.armIndex === armIndex)
    )
  }, [numArms, pulls])

  const visibleByArm = useMemo(() => {
    return pullsByArm.map((armPulls) => {
      const rewards = armPulls.map((pull) => pull.reward)
      if (visibilityMode === 'none') {
        return []
      }
      if (visibilityMode === 'last-3') {
        return rewards.slice(-3)
      }
      return rewards
    })
  }, [pullsByArm, visibilityMode])

  useEffect(() => {
    async function loadExperimentBrief() {
      try {
        setError('')
        const response = await fetch('/api/participant/experiment')
        const data = await parseJsonResponse<ExperimentBrief & { error?: string }>(response)

        if (!response.ok) {
          throw new Error(buildHttpErrorMessage(data, 'Failed to load experiment details', response))
        }

        if (!data) {
          throw new Error('Invalid experiment response from server.')
        }

        setExperimentBrief(data)
        setParticipantStage('intro')
      } catch (err) {
        setError(toUserErrorMessage(err, 'Failed to load experiment details'))
        setParticipantStage('intro')
      }
    }

    void loadExperimentBrief()
  }, [])

  useEffect(() => {
    return () => {
      if (pullTimerRef.current !== null) {
        window.clearTimeout(pullTimerRef.current)
      }
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  async function loadAdminData(token: string) {
    const [configResponse, sessionsResponse] = await Promise.all([
      fetch('/api/admin/experiment', { headers: { 'x-admin-token': token } }),
      fetch('/api/admin/sessions', { headers: { 'x-admin-token': token } }),
    ])

    if (!configResponse.ok || !sessionsResponse.ok) {
      throw new Error('Failed to load admin dashboard data')
    }

    const configData = (await configResponse.json()) as { config: ExperimentConfig }
    const sessionsData = (await sessionsResponse.json()) as { rows: AdminSessionRow[] }

    setAdminConfig(configData.config)
    setAdminSessions(sessionsData.rows)
  }

  async function adminLogin() {
    try {
      setError('')
      setAdminMessage('')
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPasswordInput }),
      })

      const data = await parseJsonResponse<{ token?: string; error?: string }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Admin login failed', response))
      }

      if (!data?.token) {
        throw new Error('Invalid admin login response from server.')
      }

      setAdminToken(data.token)
      await loadAdminData(data.token)
      setAdminMessage('Admin access granted.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Admin login failed'))
    }
  }

  async function refreshAdminData() {
    if (!adminToken) {
      return
    }
    try {
      setError('')
      await loadAdminData(adminToken)
      setAdminMessage('Dashboard refreshed.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to refresh dashboard'))
    }
  }

  async function saveAdminConfig() {
    if (!adminToken || !adminConfig) {
      return
    }

    try {
      setError('')
      setAdminMessage('')
      const response = await fetch('/api/admin/experiment', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken,
        },
        body: JSON.stringify({ config: adminConfig }),
      })

      const data = await parseJsonResponse<{ error?: string }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to save experiment config', response))
      }

      setAdminMessage('Experiment configuration saved.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to save config'))
    }
  }

  async function deleteSessionHistory(sessionId: string) {
    if (!adminToken) {
      return
    }

    const confirmed = window.confirm(
      `Delete all stored history for session ${sessionId}? This cannot be undone.`
    )
    if (!confirmed) {
      return
    }

    try {
      setError('')
      setAdminMessage('')
      const response = await fetch(`/api/admin/history/${sessionId}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken },
      })

      const data = await parseJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to delete session history', response))
      }

      setAdminSessions((prev) => prev.filter((row) => row.id !== sessionId))
      setAdminMessage('Session history deleted.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to delete session history'))
    }
  }

  async function deleteAllHistory() {
    if (!adminToken) {
      return
    }

    const confirmed = window.confirm(
      'Delete ALL participant history data (sessions, pulls, questionnaire, memory details, metrics)? This cannot be undone.'
    )
    if (!confirmed) {
      return
    }

    try {
      setError('')
      setAdminMessage('')
      const response = await fetch('/api/admin/history', {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken },
      })

      const data = await parseJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to delete all history', response))
      }

      setAdminSessions([])
      setAdminMessage('All participant history deleted.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to delete all history'))
    }
  }

  async function startSession(nextRunType: RunType) {
    try {
      setError('')
      const normalizedParticipantId = participantId.trim().toUpperCase()

      if (!/^[A-Z0-9_-]{4,32}$/.test(normalizedParticipantId)) {
        setError('Participant ID is required. Use 4-32 chars: letters, numbers, _ or -.')
        return
      }

      const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: normalizedParticipantId,
          runType: nextRunType,
        }),
      })

      const data = await parseJsonResponse<SessionStartResponse & { error?: string }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to start session', response))
      }

      if (!data) {
        throw new Error('Invalid session start response from server.')
      }

      setSessionId(data.sessionId)
      setNumArms(data.settings.numArms)
      setRounds(data.settings.rounds)
      setVisibilityMode(data.settings.visibilityMode)
      setBanditMeans(data.banditMeans)
      setRunType(data.runType)
      setAbGroup(data.abGroup)
      setPulls([])
      setPullInProgress(false)
      setActiveArmIndex(null)
      setLatestPullFeedback(null)
      setRecalledSequenceInput('')
      setPerceivedAverageInput('')
      setMetrics(null)
      setParticipantStage('play')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to start session'))
    }
  }

  function pullArm(armIndex: number) {
    if (finished || participantStage !== 'play' || pullInProgress) {
      return
    }

    setPullInProgress(true)
    setActiveArmIndex(armIndex)
    setLatestPullFeedback(null)

    if (pullTimerRef.current !== null) {
      window.clearTimeout(pullTimerRef.current)
    }
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
    }

    pullTimerRef.current = window.setTimeout(() => {
      const mean = banditMeans[armIndex] ?? 0
      const reward = Math.random() < mean ? 1 : 0
      const nextPulls = [...pulls, { roundIndex: currentRound, armIndex, reward }]
      const nextRoundNumber = nextPulls.length

      setPulls(nextPulls)
      setLatestPullFeedback({
        armIndex,
        reward,
        roundNumber: nextRoundNumber,
      })
      setPullInProgress(false)
      setActiveArmIndex(null)

      if (nextPulls.length >= rounds) {
        transitionTimerRef.current = window.setTimeout(() => {
          const targetArm = getMostPulledArmIndex(nextPulls, numArms)
          setQuestionTargetArm(targetArm)
          setParticipantStage('questionnaire')
          setLatestPullFeedback(null)
        }, ROUND_TRANSITION_MS)
      }
    }, PULL_REVEAL_MS)
  }

  function computeMetrics(recalledSequence: number[], perceivedAverage: number): Metrics {
    const totalReward = pulls.reduce((sum, pull) => sum + pull.reward, 0)
    const averageReward = pulls.length > 0 ? totalReward / pulls.length : 0

    let bestArmIndex = 0
    let bestArmMean = banditMeans[0] ?? 0
    for (let i = 1; i < banditMeans.length; i += 1) {
      if (banditMeans[i] > bestArmMean) {
        bestArmMean = banditMeans[i]
        bestArmIndex = i
      }
    }

    const expectedCollected = pulls.reduce(
      (sum, pull) => sum + (banditMeans[pull.armIndex] ?? 0),
      0
    )
    const expectedRegret = rounds * bestArmMean - expectedCollected

    const targetArmHistory = pulls
      .filter((pull) => pull.armIndex === questionTargetArm)
      .map((pull) => pull.reward)
      .reverse()

    const compareLength = Math.min(targetArmHistory.length, recalledSequence.length)
    let weightedCorrect = 0
    let weightTotal = 0
    for (let i = 0; i < compareLength; i += 1) {
      const weight = 1 / (i + 1)
      if (targetArmHistory[i] === recalledSequence[i]) {
        weightedCorrect += weight
      }
      weightTotal += weight
    }

    const recencyWeightedAccuracy = weightTotal > 0 ? weightedCorrect / weightTotal : null
    const actualTargetAverage =
      targetArmHistory.length > 0
        ? targetArmHistory.reduce((sum, reward) => sum + reward, 0) / targetArmHistory.length
        : 0

    const perceivedAverageError = Number.isFinite(perceivedAverage)
      ? Math.abs(perceivedAverage - actualTargetAverage)
      : null

    const uniqueArmsChosen = new Set(pulls.map((pull) => pull.armIndex)).size

    return {
      totalReward,
      averageReward,
      bestArmIndex,
      bestArmMean,
      expectedRegret,
      recencyWeightedAccuracy,
      perceivedAverageError,
      uniqueArmsChosen,
    }
  }

  async function submitQuestionnaire() {
    const recalledSequence = parseRecallInput(recalledSequenceInput)
    const perceivedAverage = Number(perceivedAverageInput)

    if (recalledSequence.length === 0) {
      setError('Please enter at least one remembered reward value.')
      return
    }

    if (!Number.isFinite(perceivedAverage)) {
      setError('Please enter a valid number for perceived average reward.')
      return
    }

    setSaving(true)
    setError('')

    const nextMetrics = computeMetrics(recalledSequence, perceivedAverage)

    try {
      const response = await fetch(`/api/sessions/${sessionId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runType,
          pulls,
          questionnaire: {
            targetArm: questionTargetArm,
            recalledSequence,
            perceivedAverage,
          },
          metrics: nextMetrics,
        }),
      })

      const data = await parseJsonResponse<{ error?: string }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to save the game results', response))
      }

      setMetrics(nextMetrics)

      if (runType === 'practice') {
        setParticipantStage('run-result')
      } else {
        setParticipantStage('final-complete')
      }
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to complete session'))
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    setParticipantStage('intro')
    setPulls([])
    setBanditMeans([])
    setSessionId('')
    setMetrics(null)
    setRecalledSequenceInput('')
    setPerceivedAverageInput('')
    setRounds(0)
    setPullInProgress(false)
    setActiveArmIndex(null)
    setLatestPullFeedback(null)
    setError('')
  }

  function updateAdminConfig<K extends keyof ExperimentConfig>(key: K, value: ExperimentConfig[K]) {
    if (!adminConfig) {
      return
    }
    setAdminConfig({ ...adminConfig, [key]: value })
  }

  function updateGroupVisibility(group: ABGroup, value: VisibilityMode) {
    if (!adminConfig) {
      return
    }

    setAdminConfig({
      ...adminConfig,
      groupConfigs: {
        ...adminConfig.groupConfigs,
        [group]: { visibilityMode: value },
      },
    })
  }

  function updateNumArmsWithProbabilities(nextNumArms: number) {
    if (!adminConfig) {
      return
    }

    const safeNumArms = Number.isInteger(nextNumArms)
      ? Math.min(20, Math.max(2, nextNumArms))
      : adminConfig.numArms

    const current = adminConfig.armProbabilities ?? []
    const resized = Array.from({ length: safeNumArms }, (_, index) => {
      if (index < current.length && Number.isFinite(current[index])) {
        return Number(current[index].toFixed(4))
      }
      return 0.5
    })

    setAdminConfig({
      ...adminConfig,
      numArms: safeNumArms,
      armProbabilities: resized,
    })
  }

  function updateArmProbability(index: number, value: string) {
    if (!adminConfig) {
      return
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return
    }

    const clamped = Math.min(1, Math.max(0, parsed))
    const next = [...adminConfig.armProbabilities]
    next[index] = Number(clamped.toFixed(4))

    setAdminConfig({
      ...adminConfig,
      armProbabilities: next,
    })
  }

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <p className="eyebrow">Behavioral Experiment Platform</p>
        <h1>{experimentBrief?.title ?? 'Multi-Armed Bandit Study'}</h1>
        <p className="hero-copy">
          Controlled participant experiments with required memory testing, optional practice,
          and admin-managed A/B conditions.
        </p>

        <div className="mode-toggle">
          <button
            className={mode === 'participant' ? 'secondary-button' : 'ghost-button'}
            onClick={() => setMode('participant')}
          >
            Participant Portal
          </button>
          <button
            className={mode === 'admin' ? 'secondary-button' : 'ghost-button'}
            onClick={() => setMode('admin')}
          >
            Admin Dashboard
          </button>
        </div>
      </section>

      {error && <p className="error-banner">{error}</p>}
      {adminMessage && <p className="ok-banner">{adminMessage}</p>}

      {mode === 'participant' && participantStage === 'loading' && (
        <section className="panel">
          <h2>Loading Experiment</h2>
          <p className="setup-note">Please wait while we fetch the active experiment setup.</p>
        </section>
      )}

      {mode === 'participant' && participantStage === 'intro' && experimentBrief && (
        <section className="panel">
          <h2>Participant Instructions</h2>
          <p className="question-text">Purpose: {experimentBrief.purpose}</p>
          <p className="question-text">Instructions: {experimentBrief.instructions}</p>
          <p className="setup-note">
            The memory questionnaire is mandatory to complete the experiment. It does not
            affect your score.
          </p>

          <label>
            Participant ID (required)
            <input
              value={participantId}
              onChange={(event) => setParticipantId(event.target.value)}
              placeholder="e.g. P_0142"
            />
          </label>

          <p className="setup-note">
            Each participant ID can complete the final experiment only once.
          </p>

          <div className="action-row">
            {experimentBrief.practiceEnabled && (
              <button className="secondary-button" onClick={() => startSession('practice')}>
                Start Practice Run
              </button>
            )}
            <button className="primary-button" onClick={() => startSession('final')}>
              Start Final Run
            </button>
          </div>
        </section>
      )}

      {mode === 'participant' && participantStage === 'play' && (
        <section className="panel">
          <div className="panel-header-row">
            <h2>{runType === 'practice' ? 'Practice Run' : 'Final Run'}</h2>
            <p>
              Round {currentRound + 1} / {rounds}
            </p>
          </div>

          <p className="condition-pill">Visibility: {visibilityLabels[visibilityMode]}</p>
          <p className="setup-note">A/B Group: {abGroup}</p>

          <section className="pull-feedback-panel">
            <p className="pull-status-line">
              {pullInProgress && activeArmIndex !== null
                ? `Pulling Arm ${activeArmIndex + 1}... revealing reward shortly`
                : 'Choose one arm, then wait for the reward reveal before the next pull.'}
            </p>
            <p className="score-line">Total reward so far: {totalRewardSoFar}</p>
            {latestPullFeedback && !pullInProgress && (
              <div
                className={`reward-pop ${latestPullFeedback.reward === 1 ? 'is-win' : 'is-loss'}`}
              >
                Round {latestPullFeedback.roundNumber}: Arm {latestPullFeedback.armIndex + 1}{' '}
                returned reward {latestPullFeedback.reward}
              </div>
            )}
          </section>

          <div className="arm-grid">
            {Array.from({ length: numArms }, (_, armIndex) => {
              const history = visibleByArm[armIndex] ?? []
              const armPulls = pullsByArm[armIndex] ?? []
              const rewardSum = armPulls.reduce((sum, pull) => sum + pull.reward, 0)
              const rewardAvg = armPulls.length > 0 ? rewardSum / armPulls.length : 0

              return (
                <article
                  key={armIndex}
                  className={`arm-card ${activeArmIndex === armIndex ? 'is-active' : ''}`}
                >
                  <h3>Arm {armIndex + 1}</h3>
                  <button
                    className="secondary-button"
                    onClick={() => pullArm(armIndex)}
                    disabled={pullInProgress}
                  >
                    Pull Arm {armIndex + 1}
                  </button>
                  {visibilityMode === 'summary' ? (
                    <p className="history-line">
                      pulls={armPulls.length}, avg={format(rewardAvg)}
                    </p>
                  ) : visibilityMode === 'none' ? (
                    <p className="history-line">history hidden</p>
                  ) : (
                    <p className="history-line">
                      visible rewards: {history.length > 0 ? history.join(', ') : 'none yet'}
                    </p>
                  )}
                </article>
              )
            })}
          </div>

          <div className="setup-note">
            Latest reward: {pulls.length > 0 ? pulls[pulls.length - 1].reward : 'No pull yet'}
          </div>
        </section>
      )}

      {mode === 'participant' && participantStage === 'questionnaire' && (
        <section className="panel">
          <h2>Memory Questionnaire</h2>
          <p className="question-text">
            For Arm {questionTargetArm + 1}, list rewards you remember from most recent to
            older in order. Use comma or space separated numbers.
          </p>
          <textarea
            value={recalledSequenceInput}
            onChange={(event) => setRecalledSequenceInput(event.target.value)}
            rows={4}
            placeholder="Example: 1, 0, 1, 1"
          />

          <label>
            What average reward do you think this arm gives?
            <input
              type="number"
              min={0}
              max={1}
              step="0.01"
              value={perceivedAverageInput}
              onChange={(event) => setPerceivedAverageInput(event.target.value)}
              placeholder="Example: 0.62"
            />
          </label>

          <button className="primary-button" onClick={submitQuestionnaire} disabled={saving}>
            {saving ? 'Saving...' : 'Submit Answers'}
          </button>
        </section>
      )}

      {mode === 'participant' && participantStage === 'run-result' && metrics && (
        <section className="panel">
          <h2>Practice Complete</h2>
          <ul className="metrics-list">
            <li>Total reward: {format(metrics.totalReward)}</li>
            <li>Average reward per round: {format(metrics.averageReward)}</li>
            <li>Expected regret: {format(metrics.expectedRegret)}</li>
            <li>
              Recency-weighted recall accuracy:{' '}
              {metrics.recencyWeightedAccuracy === null
                ? 'N/A'
                : format(metrics.recencyWeightedAccuracy)}
            </li>
          </ul>
          <p className="setup-note">
            Practice is not counted in final performance. Complete the final run next.
          </p>
          <button className="primary-button" onClick={() => startSession('final')}>
            Start Final Run
          </button>
        </section>
      )}

      {mode === 'participant' && participantStage === 'final-complete' && metrics && (
        <section className="panel">
          <h2>Final Run Complete</h2>
          <ul className="metrics-list">
            <li>Total reward: {format(metrics.totalReward)}</li>
            <li>Average reward per round: {format(metrics.averageReward)}</li>
            <li>
              Best true arm: {metrics.bestArmIndex + 1} (mean={format(metrics.bestArmMean)})
            </li>
            <li>Expected regret: {format(metrics.expectedRegret)}</li>
            <li>
              Recency-weighted recall accuracy:{' '}
              {metrics.recencyWeightedAccuracy === null
                ? 'N/A'
                : format(metrics.recencyWeightedAccuracy)}
            </li>
            <li>
              Perceived-average error:{' '}
              {metrics.perceivedAverageError === null
                ? 'N/A'
                : format(metrics.perceivedAverageError)}
            </li>
            <li>Unique arms chosen: {metrics.uniqueArmsChosen}</li>
          </ul>

          <p className="setup-note">
            Session id: {sessionId}. The memory test was required to complete your experiment.
          </p>

          <button className="primary-button" onClick={reset}>
            Start New Participant Session
          </button>
        </section>
      )}

      {mode === 'admin' && !adminToken && (
        <section className="panel">
          <h2>Admin Login</h2>
          <p className="setup-note">
            Protected access. Set ADMIN_PASSWORD in your environment so only you can enter.
          </p>
          <label>
            Admin password
            <input
              type="password"
              value={adminPasswordInput}
              onChange={(event) => setAdminPasswordInput(event.target.value)}
            />
          </label>
          <button className="primary-button" onClick={adminLogin}>
            Login
          </button>
        </section>
      )}

      {mode === 'admin' && adminToken && adminConfig && (
        <section className="panel">
          <div className="panel-header-row">
            <h2>Admin Dashboard</h2>
            <div className="action-row">
              <button className="secondary-button" onClick={refreshAdminData}>
                Refresh Data
              </button>
              <button className="danger-button" onClick={deleteAllHistory}>
                Delete All History
              </button>
            </div>
          </div>

          <h3>Experiment Control</h3>
          <div className="grid-2">
            <label>
              Study title
              <input
                value={adminConfig.title}
                onChange={(event) => updateAdminConfig('title', event.target.value)}
              />
            </label>
            <label>
              Number of arms
              <input
                type="number"
                min={2}
                max={20}
                value={adminConfig.numArms}
                onChange={(event) => updateNumArmsWithProbabilities(Number(event.target.value))}
              />
            </label>
          </div>

          <label>
            Arm reward probabilities (0 to 1)
            <div className="prob-grid">
              {Array.from({ length: adminConfig.numArms }, (_, index) => (
                <label key={`prob-${index}`} className="mini-label">
                  Arm {index + 1}
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step="0.01"
                    value={adminConfig.armProbabilities[index] ?? 0.5}
                    onChange={(event) => updateArmProbability(index, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </label>

          <label>
            Purpose
            <textarea
              rows={3}
              value={adminConfig.purpose}
              onChange={(event) => updateAdminConfig('purpose', event.target.value)}
            />
          </label>

          <label>
            Instructions shown to participant
            <textarea
              rows={4}
              value={adminConfig.instructions}
              onChange={(event) => updateAdminConfig('instructions', event.target.value)}
            />
          </label>

          <div className="grid-3">
            <label>
              Practice enabled
              <select
                value={adminConfig.practiceEnabled ? 'yes' : 'no'}
                onChange={(event) => updateAdminConfig('practiceEnabled', event.target.value === 'yes')}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label>
              Practice rounds
              <input
                type="number"
                min={3}
                max={200}
                value={adminConfig.practiceRounds}
                onChange={(event) =>
                  updateAdminConfig('practiceRounds', Number(event.target.value))
                }
              />
            </label>
            <label>
              Final rounds
              <input
                type="number"
                min={5}
                max={500}
                value={adminConfig.finalRounds}
                onChange={(event) => updateAdminConfig('finalRounds', Number(event.target.value))}
              />
            </label>
          </div>

          <div className="grid-3">
            <label>
              A/B testing enabled
              <select
                value={adminConfig.abTestingEnabled ? 'yes' : 'no'}
                onChange={(event) =>
                  updateAdminConfig('abTestingEnabled', event.target.value === 'yes')
                }
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>

            <label>
              Group A visibility
              <select
                value={adminConfig.groupConfigs.A.visibilityMode}
                onChange={(event) =>
                  updateGroupVisibility('A', event.target.value as VisibilityMode)
                }
              >
                <option value="none">None</option>
                <option value="last-3">Last 3</option>
                <option value="full">Full</option>
                <option value="summary">Summary</option>
              </select>
            </label>

            <label>
              Group B visibility
              <select
                value={adminConfig.groupConfigs.B.visibilityMode}
                onChange={(event) =>
                  updateGroupVisibility('B', event.target.value as VisibilityMode)
                }
              >
                <option value="none">None</option>
                <option value="last-3">Last 3</option>
                <option value="full">Full</option>
                <option value="summary">Summary</option>
              </select>
            </label>
          </div>

          <label>
            Default visibility mode (used when A/B is disabled)
            <select
              value={adminConfig.defaultVisibilityMode}
              onChange={(event) =>
                updateAdminConfig('defaultVisibilityMode', event.target.value as VisibilityMode)
              }
            >
              <option value="none">None</option>
              <option value="last-3">Last 3</option>
              <option value="full">Full</option>
              <option value="summary">Summary</option>
            </select>
          </label>

          <button className="primary-button" onClick={saveAdminConfig}>
            Save Experiment Config
          </button>

          <h3 className="admin-table-title">Recent Session Results</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Participant</th>
                  <th>Run</th>
                  <th>Group</th>
                  <th>Total</th>
                  <th>Avg</th>
                  <th>Regret</th>
                  <th>Recency Acc.</th>
                  <th>Perceived Err.</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {adminSessions.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id.slice(-8)}</td>
                    <td>{row.participant_id ?? '-'}</td>
                    <td>{row.run_type}</td>
                    <td>{row.ab_group}</td>
                    <td>{row.total_reward === null ? '-' : format(row.total_reward)}</td>
                    <td>{row.average_reward === null ? '-' : format(row.average_reward)}</td>
                    <td>{row.expected_regret === null ? '-' : format(row.expected_regret)}</td>
                    <td>
                      {row.recency_weighted_accuracy === null
                        ? '-'
                        : format(row.recency_weighted_accuracy)}
                    </td>
                    <td>
                      {row.perceived_average_error === null
                        ? '-'
                        : format(row.perceived_average_error)}
                    </td>
                    <td>
                      <button
                        className="danger-button small"
                        onClick={() => deleteSessionHistory(row.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
