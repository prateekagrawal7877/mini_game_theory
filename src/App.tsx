import { useEffect, useMemo, useRef, useState } from 'react'

type VisibilityMode = 'none' | 'last-3' | 'full' | 'summary'
type ABGroup = 'A' | 'B'
type RunType = 'practice' | 'final'
type AppMode = 'participant' | 'admin'

type ParticipantStage =
  | 'loading'
  | 'intro'
  | 'play'
  | 'between-experiments'
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

type FinalExperimentSummary = {
  experimentLabel: string
  totalReward: number
  averageReward: number
  expectedRegret: number
  uniqueArmsChosen: number
}

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

type ExperimentBrief = {
  title: string
  purpose: string
  instructions: string
  exitAllowed: boolean
  practiceEnabled: boolean
  practiceConfig: PracticeConfig
  maxFinalExperimentsPerParticipant: number
  experiments: ExperimentDefinition[]
  groupDisplayDefaults: {
    A: {
      showRoundHistory: boolean
      showArmPullCounts: boolean
      showCurrentArmProbabilities: boolean
      showCustomInstruction: boolean
      customInstruction: string
    }
    B: {
      showRoundHistory: boolean
      showArmPullCounts: boolean
      showCurrentArmProbabilities: boolean
      showCustomInstruction: boolean
      customInstruction: string
    }
  }
}

type SessionStartResponse = {
  sessionId: string
  settings: {
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
  banditMeans: number[]
  experiment: {
    id: string
    label: string
  }
  runType: RunType
  abGroup: ABGroup
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

type AdminSessionRow = {
  id: string
  created_at: string
  participant_id: string | null
  experiment_id: string | null
  run_type: string
  ab_group: string
  total_reward: number | null
  average_reward: number | null
  expected_regret: number | null
  recency_weighted_accuracy: number | null
  perceived_average_error: number | null
}

function format(value: number): string {
  return value.toFixed(3)
}

function normalizeParticipantIdentifier(value: string): string {
  return value.trim().toLowerCase()
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
  const [participantOtp, setParticipantOtp] = useState<string>('')
  const [participantOtpRequested, setParticipantOtpRequested] = useState<boolean>(false)
  const [participantVerified, setParticipantVerified] = useState<boolean>(false)
  const [participantLoginToken, setParticipantLoginToken] = useState<string>('')
  const [authBusy, setAuthBusy] = useState<boolean>(false)
  const [activeParticipantId, setActiveParticipantId] = useState<string>('')
  const [sequenceExperiments, setSequenceExperiments] = useState<ExperimentDefinition[]>([])
  const [sequenceIndex, setSequenceIndex] = useState<number>(0)
  const [pendingNextIndex, setPendingNextIndex] = useState<number | null>(null)
  const [justCompletedExperimentLabel, setJustCompletedExperimentLabel] = useState<string>('')
  const [sequenceRunType, setSequenceRunType] = useState<RunType>('final')
  const [finalExperimentSummaries, setFinalExperimentSummaries] = useState<FinalExperimentSummary[]>([])
  const [finalSequenceExitedEarly, setFinalSequenceExitedEarly] = useState<boolean>(false)
  const [activeExperimentLabel, setActiveExperimentLabel] = useState<string>('')

  const [numArms, setNumArms] = useState<number>(2)
  const [rounds, setRounds] = useState<number>(0)
  const [exitAllowed, setExitAllowed] = useState<boolean>(true)
  const [showRoundHistory, setShowRoundHistory] = useState<boolean>(false)
  const [showArmPullCounts, setShowArmPullCounts] = useState<boolean>(false)
  const [showCurrentArmProbabilities, setShowCurrentArmProbabilities] = useState<boolean>(false)
  const [showGroupInstruction, setShowGroupInstruction] = useState<boolean>(false)
  const [groupInstruction, setGroupInstruction] = useState<string>('')
  const [runType, setRunType] = useState<RunType>('final')

  const [sessionId, setSessionId] = useState<string>('')
  const [banditMeans, setBanditMeans] = useState<number[]>([])
  const [pulls, setPulls] = useState<Pull[]>([])
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState<string>('')
  const [saving, setSaving] = useState<boolean>(false)

  const [adminPasswordInput, setAdminPasswordInput] = useState<string>('')
  const [adminToken, setAdminToken] = useState<string>('')
  const [adminConfig, setAdminConfig] = useState<ExperimentConfig | null>(null)
  const [adminSessions, setAdminSessions] = useState<AdminSessionRow[]>([])
  const [adminMessage, setAdminMessage] = useState<string>('')
  const [adminSaving, setAdminSaving] = useState<boolean>(false)
  const [adminExporting, setAdminExporting] = useState<boolean>(false)
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
  const finalSummaryTotals = useMemo(() => {
    if (finalExperimentSummaries.length === 0) {
      return {
        totalReward: 0,
        meanAverageReward: 0,
        totalExpectedRegret: 0,
      }
    }

    const totalReward = finalExperimentSummaries.reduce(
      (sum, row) => sum + row.totalReward,
      0
    )
    const meanAverageReward =
      finalExperimentSummaries.reduce((sum, row) => sum + row.averageReward, 0) /
      finalExperimentSummaries.length
    const totalExpectedRegret = finalExperimentSummaries.reduce(
      (sum, row) => sum + row.expectedRegret,
      0
    )

    return {
      totalReward,
      meanAverageReward,
      totalExpectedRegret,
    }
  }, [finalExperimentSummaries])

  const pullsByArm = useMemo(() => {
    return Array.from({ length: numArms }, (_, armIndex) =>
      pulls.filter((pull) => pull.armIndex === armIndex)
    )
  }, [numArms, pulls])

  const estimatedProbabilityByArm = useMemo(
    () =>
      pullsByArm.map((armPulls) => {
        if (armPulls.length === 0) {
          return null
        }
        const rewardSum = armPulls.reduce((sum, pull) => sum + pull.reward, 0)
        return rewardSum / armPulls.length
      }),
    [pullsByArm]
  )

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

  useEffect(() => {
    if (!error) {
      return
    }

    const timer = window.setTimeout(() => {
      setError('')
    }, 7000)

    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    if (!adminMessage) {
      return
    }

    const timer = window.setTimeout(() => {
      setAdminMessage('')
    }, 7000)

    return () => window.clearTimeout(timer)
  }, [adminMessage])

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
    if (!adminToken || !adminConfig || adminSaving) {
      return
    }

    try {
      setAdminSaving(true)
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

      const data = await parseJsonResponse<{ error?: string; config?: ExperimentConfig }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to save experiment config', response))
      }

      if (data?.config) {
        setAdminConfig(data.config)
      }
      setAdminMessage('Experiment configuration saved.')
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to save config'))
    } finally {
      setAdminSaving(false)
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
      'Delete ALL participant history data (sessions, pulls, metrics)? This cannot be undone.'
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

  async function downloadAdminCsv(endpoint: string, downloadName: string): Promise<void> {
    if (!adminToken) {
      throw new Error('Admin token missing')
    }

    const response = await fetch(endpoint, {
      headers: { 'x-admin-token': adminToken },
    })

    if (!response.ok) {
      const data = await parseJsonResponse<{ error?: string }>(response)
      throw new Error(buildHttpErrorMessage(data, 'Failed to export CSV', response))
    }

    const blob = await response.blob()
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = downloadName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.URL.revokeObjectURL(url)
  }

  async function exportExperimentCsvs() {
    if (!adminConfig || adminExporting) {
      return
    }

    setAdminExporting(true)
    setError('')
    setAdminMessage('')

    try {
      const allExperimentIds = adminConfig.experiments.map((experiment) => experiment.id)

      if (allExperimentIds.length === 0) {
        throw new Error('No experiments found to export.')
      }

      for (const experimentId of allExperimentIds) {
        // Add timestamp cache buster for fresh downloads on re-export
        await downloadAdminCsv(
          `/api/admin/export/experiment/${encodeURIComponent(experimentId)}?t=${Date.now()}`,
          `experiment_${experimentId}_pull_history.csv`
        )
      }

      setAdminMessage(
        `Exported ${allExperimentIds.length} CSV file(s), one per experiment with A/B group labels included.`
      )
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to export CSV files'))
    } finally {
      setAdminExporting(false)
    }
  }

  async function startSingleSession(
    nextRunType: RunType,
    normalizedParticipantId: string,
    experiment: ExperimentDefinition | null
  ): Promise<boolean> {
    try {
      setError('')

      const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: normalizedParticipantId,
          loginToken: participantLoginToken,
          experimentId: experiment?.id,
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
      setExitAllowed(data.settings.exitAllowed)
      setShowRoundHistory(data.settings.showRoundHistory)
      setShowArmPullCounts(data.settings.showArmPullCounts)
      setShowCurrentArmProbabilities(data.settings.showCurrentArmProbabilities)
      setShowGroupInstruction(data.settings.showGroupInstruction)
      setGroupInstruction(data.settings.groupInstruction)
      setActiveExperimentLabel(data.settings.experimentLabel)
      setBanditMeans(data.banditMeans)
      setRunType(data.runType)

      if (nextRunType === 'final' && sequenceExperiments.length > 0) {
        const resolvedIndex = sequenceExperiments.findIndex(
          (candidate) => candidate.id === data.experiment.id
        )
        if (resolvedIndex >= 0) {
          setSequenceIndex(resolvedIndex)
        }
      }

      setPulls([])
      setPullInProgress(false)
      setActiveArmIndex(null)
      setLatestPullFeedback(null)
      setMetrics(null)
      setParticipantStage('play')
      return true
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to start session'))
      return false
    }
  }

  async function startSession(nextRunType: RunType) {
    const normalizedParticipantId = normalizeParticipantIdentifier(participantId)

    if (!participantVerified || !participantLoginToken) {
      setError('Please verify your email with OTP before starting the experiment.')
      return
    }

    setActiveParticipantId(normalizedParticipantId)
    setSequenceRunType(nextRunType)
    setFinalSequenceExitedEarly(false)
    setPendingNextIndex(null)
    setJustCompletedExperimentLabel('')

    if (nextRunType === 'practice') {
      setSequenceExperiments([])
      setSequenceIndex(0)
      setFinalExperimentSummaries([])
      await startSingleSession('practice', normalizedParticipantId, null)
      return
    }

    const enabledExperiments = (experimentBrief?.experiments ?? []).filter(
      (experiment) => experiment.enabled
    )

    if (enabledExperiments.length === 0) {
      setError('No enabled experiments are currently available.')
      return
    }

    setSequenceExperiments(enabledExperiments)
    setSequenceIndex(0)
    setFinalExperimentSummaries([])

    await startSingleSession('final', normalizedParticipantId, enabledExperiments[0])
  }

  async function continueToNextExperiment() {
    if (pendingNextIndex === null || !activeParticipantId) {
      return
    }

    const nextExperiment = sequenceExperiments[pendingNextIndex]
    if (!nextExperiment) {
      return
    }

    const started = await startSingleSession('final', activeParticipantId, nextExperiment)
    if (!started) {
      return
    }

    setPendingNextIndex(null)
    setJustCompletedExperimentLabel('')
  }

  function clearPendingTimers() {
    if (pullTimerRef.current !== null) {
      window.clearTimeout(pullTimerRef.current)
      pullTimerRef.current = null
    }
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
  }

  async function exitCurrentTrial() {
    const confirmed = window.confirm(
      'Exit current trial? Progress for this trial will be discarded and not saved.'
    )
    if (!confirmed) {
      return
    }

    clearPendingTimers()
    setPullInProgress(false)
    setActiveArmIndex(null)
    setLatestPullFeedback(null)

    if (sessionId) {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId: activeParticipantId || normalizeParticipantIdentifier(participantId),
          }),
        })

        const data = await parseJsonResponse<{ error?: string }>(response)
        if (!response.ok) {
          throw new Error(buildHttpErrorMessage(data, 'Failed to exit current trial', response))
        }
      } catch (err) {
        setError(toUserErrorMessage(err, 'Failed to exit current trial'))
        return
      }
    }

    if (sequenceRunType === 'final') {
      setParticipantStage('final-complete')
      setFinalSequenceExitedEarly(true)
      setPulls([])
      setBanditMeans([])
      setSessionId('')
      setMetrics(null)
      setRounds(0)
      setPendingNextIndex(null)
      setJustCompletedExperimentLabel('')
      setActiveExperimentLabel('')
      setPullInProgress(false)
      setActiveArmIndex(null)
      setLatestPullFeedback(null)
      setShowGroupInstruction(false)
      setGroupInstruction('')
      setError(
        'You exited the current experiment. Completed experiments were saved; the current one was discarded.'
      )
      return
    }

    reset()
    setError('Trial exited. Progress was discarded and not saved.')
  }

  function pullArm(armIndex: number) {
    if (finished || participantStage !== 'play' || pullInProgress || saving) {
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
      setActiveArmIndex(null)

      if (nextPulls.length >= rounds) {
        // Keep pull lock active while finalizing to prevent overshooting configured rounds.
        setPullInProgress(true)
        transitionTimerRef.current = window.setTimeout(() => {
          void completeSession(nextPulls)
          setLatestPullFeedback(null)
        }, ROUND_TRANSITION_MS)
      } else {
        setPullInProgress(false)
      }
    }, PULL_REVEAL_MS)
  }

  function computeMetrics(sessionPulls: Pull[]): Metrics {
    const totalReward = sessionPulls.reduce((sum, pull) => sum + pull.reward, 0)
    const averageReward = sessionPulls.length > 0 ? totalReward / sessionPulls.length : 0

    let bestArmIndex = 0
    let bestArmMean = banditMeans[0] ?? 0
    for (let i = 1; i < banditMeans.length; i += 1) {
      if (banditMeans[i] > bestArmMean) {
        bestArmMean = banditMeans[i]
        bestArmIndex = i
      }
    }

    const expectedCollected = sessionPulls.reduce(
      (sum, pull) => sum + (banditMeans[pull.armIndex] ?? 0),
      0
    )
    const expectedRegret = rounds * bestArmMean - expectedCollected

    const uniqueArmsChosen = new Set(sessionPulls.map((pull) => pull.armIndex)).size

    return {
      totalReward,
      averageReward,
      bestArmIndex,
      bestArmMean,
      expectedRegret,
      recencyWeightedAccuracy: null,
      perceivedAverageError: null,
      uniqueArmsChosen,
    }
  }

  async function completeSession(sessionPulls: Pull[]) {
    setSaving(true)
    setError('')

    const nextMetrics = computeMetrics(sessionPulls)

    try {
      const response = await fetch(`/api/sessions/${sessionId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runType,
          pulls: sessionPulls,
          metrics: nextMetrics,
        }),
      })

      const data = await parseJsonResponse<{ error?: string }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to save the game results', response))
      }

      setMetrics(nextMetrics)
      setPullInProgress(false)

      if (sequenceRunType === 'final') {
        setFinalExperimentSummaries((prev) => [
          ...prev,
          {
            experimentLabel: activeExperimentLabel || `Experiment ${sequenceIndex + 1}`,
            totalReward: nextMetrics.totalReward,
            averageReward: nextMetrics.averageReward,
            expectedRegret: nextMetrics.expectedRegret,
            uniqueArmsChosen: nextMetrics.uniqueArmsChosen,
          },
        ])
      }

      const hasSequence = sequenceExperiments.length > 0
      const isLastExperiment = !hasSequence || sequenceIndex >= sequenceExperiments.length - 1

      if (!isLastExperiment && activeParticipantId) {
        const nextIndex = sequenceIndex + 1
        setPendingNextIndex(nextIndex)
        setJustCompletedExperimentLabel(activeExperimentLabel || `Experiment ${sequenceIndex + 1}`)
        setParticipantStage('between-experiments')
      } else if (sequenceRunType === 'practice') {
        setParticipantStage('run-result')
      } else {
        setFinalSequenceExitedEarly(false)
        setParticipantStage('final-complete')
      }
    } catch (err) {
      setPullInProgress(false)
      setError(toUserErrorMessage(err, 'Failed to complete session'))
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    clearPendingTimers()
    setParticipantStage('intro')
    setPulls([])
    setBanditMeans([])
    setSessionId('')
    setMetrics(null)
    setRounds(0)
    setExitAllowed(true)
    setShowGroupInstruction(false)
    setGroupInstruction('')
    setSequenceExperiments([])
    setSequenceIndex(0)
    setPendingNextIndex(null)
    setJustCompletedExperimentLabel('')
    setFinalExperimentSummaries([])
    setFinalSequenceExitedEarly(false)
    setActiveExperimentLabel('')
    setActiveParticipantId('')
    setPullInProgress(false)
    setActiveArmIndex(null)
    setLatestPullFeedback(null)
    setError('')
  }

  async function requestParticipantOtp() {
    const normalizedParticipantId = normalizeParticipantIdentifier(participantId)
    if (!normalizedParticipantId) {
      setError('Please enter your email first.')
      return
    }

    try {
      setAuthBusy(true)
      setError('')

      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedParticipantId }),
      })

      const data = await parseJsonResponse<{ error?: string; warning?: string }>(response)
      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to request OTP', response))
      }

      setParticipantOtpRequested(true)
      setParticipantVerified(false)
      setParticipantLoginToken('')

      if (data?.warning) {
        setAdminMessage(`${data.warning} Please retry in a moment or use the tester account.`)
      } else {
        setAdminMessage('OTP sent. Please check your email and enter the code below.')
      }
    } catch (err) {
      setError(toUserErrorMessage(err, 'Failed to request OTP'))
    } finally {
      setAuthBusy(false)
    }
  }

  async function verifyParticipantOtp() {
    const normalizedParticipantId = normalizeParticipantIdentifier(participantId)
    const normalizedOtp = participantOtp.trim()

    if (!normalizedParticipantId || !normalizedOtp) {
      setError('Enter both email and OTP code to verify.')
      return
    }

    try {
      setAuthBusy(true)
      setError('')

      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalizedParticipantId,
          otp: normalizedOtp,
        }),
      })

      const data = await parseJsonResponse<{
        error?: string
        participantId?: string
        loginToken?: string
      }>(response)

      if (!response.ok) {
        throw new Error(buildHttpErrorMessage(data, 'Failed to verify OTP', response))
      }

      if (!data?.participantId || !data?.loginToken) {
        throw new Error('Invalid OTP verification response from server.')
      }

      setParticipantId(data.participantId)
      setActiveParticipantId(data.participantId)
      setParticipantLoginToken(data.loginToken)
      setParticipantVerified(true)
      setAdminMessage('Email verified. You can now start the experiment.')
    } catch (err) {
      setParticipantVerified(false)
      setParticipantLoginToken('')
      setError(toUserErrorMessage(err, 'Failed to verify OTP'))
    } finally {
      setAuthBusy(false)
    }
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
        [group]: {
          ...adminConfig.groupConfigs[group],
          visibilityMode: value,
        },
      },
    })
  }

  function updateGroupDetailToggle(
    group: ABGroup,
    key:
      | 'showRoundHistory'
      | 'showArmPullCounts'
      | 'showCurrentArmProbabilities'
      | 'showCustomInstruction',
    value: boolean
  ) {
    if (!adminConfig) {
      return
    }

    setAdminConfig({
      ...adminConfig,
      groupConfigs: {
        ...adminConfig.groupConfigs,
        [group]: {
          ...adminConfig.groupConfigs[group],
          [key]: value,
        },
      },
    })
  }

  function updateGroupCustomInstruction(group: ABGroup, value: string) {
    if (!adminConfig) {
      return
    }

    setAdminConfig({
      ...adminConfig,
      groupConfigs: {
        ...adminConfig.groupConfigs,
        [group]: {
          ...adminConfig.groupConfigs[group],
          customInstruction: value,
        },
      },
    })
  }

  function updateExperimentField<K extends keyof ExperimentDefinition>(
    experimentIndex: number,
    key: K,
    value: ExperimentDefinition[K]
  ) {
    if (!adminConfig) {
      return
    }

    const nextExperiments = [...adminConfig.experiments]
    const current = nextExperiments[experimentIndex]
    if (!current) {
      return
    }

    nextExperiments[experimentIndex] = {
      ...current,
      [key]: value,
    }

    setAdminConfig({
      ...adminConfig,
      experiments: nextExperiments,
    })
  }

  function updateExperimentNumArms(experimentIndex: number, nextNumArms: number) {
    if (!adminConfig) {
      return
    }

    const nextExperiments = [...adminConfig.experiments]
    const current = nextExperiments[experimentIndex]
    if (!current) {
      return
    }

    const safeNumArms = Number.isInteger(nextNumArms)
      ? Math.min(20, Math.max(2, nextNumArms))
      : current.numArms

    const currentProbabilities = current.armProbabilities ?? []
    const resized = Array.from({ length: safeNumArms }, (_, index) => {
      if (index < currentProbabilities.length && Number.isFinite(currentProbabilities[index])) {
        return Number(currentProbabilities[index].toFixed(4))
      }
      return 0.5
    })

    nextExperiments[experimentIndex] = {
      ...current,
      numArms: safeNumArms,
      armProbabilities: resized,
    }

    setAdminConfig({
      ...adminConfig,
      experiments: nextExperiments,
    })
  }

  function updateExperimentArmProbability(experimentIndex: number, armIndex: number, value: string) {
    if (!adminConfig) {
      return
    }

    const nextExperiments = [...adminConfig.experiments]
    const current = nextExperiments[experimentIndex]
    if (!current) {
      return
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return
    }

    const clamped = Math.min(1, Math.max(0, parsed))
    const next = [...current.armProbabilities]
    next[armIndex] = Number(clamped.toFixed(4))

    nextExperiments[experimentIndex] = {
      ...current,
      armProbabilities: next,
    }

    setAdminConfig({
      ...adminConfig,
      experiments: nextExperiments,
    })
  }

  function updatePracticeNumArms(nextNumArms: number) {
    if (!adminConfig) {
      return
    }

    const safeNumArms = Number.isInteger(nextNumArms)
      ? Math.min(20, Math.max(2, nextNumArms))
      : adminConfig.practiceConfig.numArms

    const currentProbabilities = adminConfig.practiceConfig.armProbabilities ?? []
    const resized = Array.from({ length: safeNumArms }, (_, index) => {
      if (index < currentProbabilities.length && Number.isFinite(currentProbabilities[index])) {
        return Number(currentProbabilities[index].toFixed(4))
      }
      return 0.5
    })

    setAdminConfig({
      ...adminConfig,
      practiceConfig: {
        ...adminConfig.practiceConfig,
        numArms: safeNumArms,
        armProbabilities: resized,
      },
    })
  }

  function updatePracticeArmProbability(armIndex: number, value: string) {
    if (!adminConfig) {
      return
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return
    }

    const clamped = Math.min(1, Math.max(0, parsed))
    const next = [...adminConfig.practiceConfig.armProbabilities]
    next[armIndex] = Number(clamped.toFixed(4))

    setAdminConfig({
      ...adminConfig,
      practiceConfig: {
        ...adminConfig.practiceConfig,
        armProbabilities: next,
      },
    })
  }

  function addExperimentConfig() {
    if (!adminConfig) {
      return
    }

    const nextIndex = adminConfig.experiments.length + 1
    const newExperiment: ExperimentDefinition = {
      id: `exp_${nextIndex}`,
      label: `Experiment ${nextIndex}`,
      enabled: true,
      numArms: 2,
      armProbabilities: [0.5, 0.5],
      finalRounds: 30,
    }

    setAdminConfig({
      ...adminConfig,
      experiments: [...adminConfig.experiments, newExperiment],
    })
  }

  function removeExperimentConfig(experimentIndex: number) {
    if (!adminConfig || adminConfig.experiments.length <= 1) {
      return
    }

    setAdminConfig({
      ...adminConfig,
      experiments: adminConfig.experiments.filter((_, index) => index !== experimentIndex),
    })
  }

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <p className="eyebrow">Behavioral Experiment Platform</p>
        <h1>{experimentBrief?.title ?? 'Multi-Armed Bandit Study'}</h1>
        <p className="hero-copy">
          Controlled participant experiments with configurable feedback visibility, optional practice,
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

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button
            type="button"
            className="banner-close-button"
            onClick={() => setError('')}
            aria-label="Dismiss error message"
          >
            x
          </button>
        </div>
      )}
      {adminMessage && (
        <div className="ok-banner">
          <span>{adminMessage}</span>
          <button
            type="button"
            className="banner-close-button"
            onClick={() => setAdminMessage('')}
            aria-label="Dismiss notification"
          >
            x
          </button>
        </div>
      )}

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

          <label>
            Email (required)
            <input
              type="text"
              value={participantId}
              onChange={(event) => {
                setParticipantId(event.target.value)
                setParticipantVerified(false)
                setParticipantLoginToken('')
              }}
              placeholder="e.g. user@example.com"
            />
          </label>

          <div className="action-row">
            <button
              className="secondary-button"
              onClick={() => void requestParticipantOtp()}
              disabled={authBusy}
            >
              {authBusy ? 'Please wait...' : 'Send OTP'}
            </button>
          </div>

          {participantOtpRequested && (
            <>
              <label>
                Enter OTP
                <input
                  value={participantOtp}
                  onChange={(event) => setParticipantOtp(event.target.value)}
                  placeholder="6-digit OTP"
                />
              </label>
              <div className="action-row">
                <button
                  className="secondary-button"
                  onClick={() => void verifyParticipantOtp()}
                  disabled={authBusy}
                >
                  Verify OTP
                </button>
              </div>
            </>
          )}

          {participantVerified && <p className="ok-banner">Email verified successfully.</p>}

          {experimentBrief.experiments.length === 0 && (
            <p className="setup-note">No enabled experiments are currently available.</p>
          )}

          <p className="setup-note">
            Practice trial is separate and only for familiarization. Final trial runs all enabled
            experiments one by one automatically.
          </p>

          <div className="action-row">
            {experimentBrief.practiceEnabled && (
              <button
                className="secondary-button"
                onClick={() => startSession('practice')}
                disabled={!participantVerified || !participantLoginToken}
              >
                Start Practice Trial
              </button>
            )}
            <button
              className="primary-button"
              onClick={() => startSession('final')}
              disabled={experimentBrief.experiments.length === 0 || !participantVerified || !participantLoginToken}
            >
              Start Final Trial (All Experiments)
            </button>
          </div>
        </section>
      )}

      {mode === 'participant' && participantStage === 'play' && (
        <section className="panel">
          <div className="panel-header-row">
            <h2>{runType === 'practice' ? 'Practice Run' : 'Final Run'}</h2>
            <div className="panel-header-actions">
              <p>
                Round {currentRound + 1} / {rounds}
              </p>
              {exitAllowed && (
                <button
                  className="danger-button"
                  onClick={() => void exitCurrentTrial()}
                  disabled={saving}
                >
                  Exit Trial
                </button>
              )}
            </div>
          </div>

          <p className="setup-note">
            Experiment: {activeExperimentLabel || 'Selected experiment'}
          </p>
          {showGroupInstruction && groupInstruction.trim().length > 0 && (
            <p className="setup-note">Group note: {groupInstruction}</p>
          )}
          {sequenceExperiments.length > 0 && (
            <p className="setup-note">
              Experiment progress: {sequenceIndex + 1} / {sequenceExperiments.length}
            </p>
          )}

          <section className="pull-feedback-panel">
            <p className="pull-status-line">
              {saving
                ? 'Saving session results...'
                : pullInProgress && activeArmIndex !== null
                ? `Pulling Arm ${activeArmIndex + 1}... revealing reward shortly`
                : pullInProgress
                ? 'Finalizing this experiment. Please wait...'
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
              const armPulls = pullsByArm[armIndex] ?? []

              return (
                <article
                  key={armIndex}
                  className={`arm-card ${activeArmIndex === armIndex ? 'is-active' : ''}`}
                >
                  <h3>Arm {armIndex + 1}</h3>
                  <button
                    className="secondary-button"
                    onClick={() => pullArm(armIndex)}
                    disabled={pullInProgress || saving}
                  >
                    Pull Arm {armIndex + 1}
                  </button>
                  {showCurrentArmProbabilities && (
                    <p className="history-line">
                      Estimated reward probability (from your pulls):{' '}
                      {estimatedProbabilityByArm[armIndex] === null
                        ? 'Not enough data yet'
                        : format(estimatedProbabilityByArm[armIndex] ?? 0)}
                    </p>
                  )}
                  {showArmPullCounts && (
                    <p className="history-line">Times pulled: {armPulls.length}</p>
                  )}
                </article>
              )
            })}
          </div>

          {showRoundHistory && (
            <section>
              <h3>Round History</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Arm</th>
                      <th>Reward</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pulls.map((pull) => (
                      <tr key={`${pull.roundIndex}-${pull.armIndex}-${pull.reward}`}>
                        <td>{pull.roundIndex + 1}</td>
                        <td>{pull.armIndex + 1}</td>
                        <td>{pull.reward}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      )}

      {mode === 'participant' && participantStage === 'between-experiments' && (
        <section className="panel">
          <h2>Experiment Complete</h2>
          <p className="setup-note">
            {justCompletedExperimentLabel || `Experiment ${sequenceIndex + 1}`} has ended.
          </p>
          <p className="setup-note">
            Click below when you are ready to start the next experiment.
          </p>
          <button
            className="primary-button"
            onClick={() => void continueToNextExperiment()}
            disabled={pendingNextIndex === null}
          >
            Start Next Experiment ({(pendingNextIndex ?? sequenceIndex) + 1} / {sequenceExperiments.length})
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
          </ul>
          <p className="setup-note">
            Practice trial complete. You can now start the final sequence.
          </p>
          <div className="action-row">
            <button className="primary-button" onClick={() => startSession('final')}>
              Start Final Trial (All Experiments)
            </button>
            <button className="ghost-button" onClick={reset}>
              Back to Main Page
            </button>
          </div>
        </section>
      )}

      {mode === 'participant' && participantStage === 'final-complete' && (
        <section className="panel">
          <h2>{finalSequenceExitedEarly ? 'Final Trial Ended Early' : 'Final Trial Complete'}</h2>
          <p className="setup-note">
            {finalExperimentSummaries.length > 0
              ? 'Summary across completed final experiments:'
              : 'No final experiment was completed before exiting.'}
          </p>

          {finalExperimentSummaries.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Experiment</th>
                    <th>Total Reward</th>
                    <th>Avg Reward</th>
                    <th>Expected Regret</th>
                    <th>Unique Arms</th>
                  </tr>
                </thead>
                <tbody>
                  {finalExperimentSummaries.map((row, rowIndex) => (
                    <tr key={`${row.experimentLabel}-${rowIndex}`}>
                      <td>{row.experimentLabel}</td>
                      <td>{format(row.totalReward)}</td>
                      <td>{format(row.averageReward)}</td>
                      <td>{format(row.expectedRegret)}</td>
                      <td>{row.uniqueArmsChosen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {finalExperimentSummaries.length > 0 && (
            <ul className="metrics-list">
              <li>Combined total reward: {format(finalSummaryTotals.totalReward)}</li>
              <li>Mean average reward: {format(finalSummaryTotals.meanAverageReward)}</li>
              <li>Combined expected regret: {format(finalSummaryTotals.totalExpectedRegret)}</li>
            </ul>
          )}

          <p className="setup-note">
            {finalSequenceExitedEarly
              ? 'Exited during the current experiment. Previously completed experiments remain saved.'
              : 'Final sequence complete.'}
          </p>

          <div className="action-row">
            <button className="primary-button" onClick={reset}>
              Start New Participant Session
            </button>
            <button className="ghost-button" onClick={reset}>
              Back to Main Page
            </button>
          </div>
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
              <button className="primary-button" onClick={saveAdminConfig} disabled={adminSaving}>
                {adminSaving ? 'Saving...' : 'Save All Settings'}
              </button>
              <button
                className="secondary-button"
                onClick={() => void exportExperimentCsvs()}
                disabled={adminExporting}
              >
                {adminExporting ? 'Exporting CSVs...' : 'Export Experiment CSVs'}
              </button>
              <button className="secondary-button" onClick={refreshAdminData}>
                Refresh Data
              </button>
              <button className="danger-button" onClick={deleteAllHistory}>
                Delete All History
              </button>
            </div>
          </div>

          <h3>Experiment Control</h3>
          <div className="grid-3">
            <label>
              Study title
              <input
                value={adminConfig.title}
                onChange={(event) => updateAdminConfig('title', event.target.value)}
              />
            </label>
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
              Allow participant exit
              <select
                value={adminConfig.exitAllowed ? 'yes' : 'no'}
                onChange={(event) => updateAdminConfig('exitAllowed', event.target.value === 'yes')}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label>
              Max final experiments per participant
              <input
                type="number"
                min={1}
                max={50}
                value={adminConfig.maxFinalExperimentsPerParticipant}
                onChange={(event) =>
                  updateAdminConfig(
                    'maxFinalExperimentsPerParticipant',
                    Number(event.target.value)
                  )
                }
              />
            </label>
          </div>

          <article className="arm-card">
            <h3>Practice Trial Settings</h3>
            <div className="grid-3">
              <label>
                Practice arms
                <input
                  type="number"
                  min={2}
                  max={20}
                  value={adminConfig.practiceConfig.numArms}
                  onChange={(event) => updatePracticeNumArms(Number(event.target.value))}
                />
              </label>
              <label>
                Practice rounds
                <input
                  type="number"
                  min={3}
                  max={200}
                  value={adminConfig.practiceConfig.rounds}
                  onChange={(event) =>
                    updateAdminConfig('practiceConfig', {
                      ...adminConfig.practiceConfig,
                      rounds: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>

            <label>
              Practice arm probabilities (0 to 1)
              <div className="prob-grid">
                {Array.from({ length: adminConfig.practiceConfig.numArms }, (_, armIndex) => (
                  <label key={`practice-prob-${armIndex}`} className="mini-label">
                    Arm {armIndex + 1}
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step="0.01"
                      value={adminConfig.practiceConfig.armProbabilities[armIndex] ?? 0.5}
                      onChange={(event) => updatePracticeArmProbability(armIndex, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </label>
          </article>

          <div className="action-row">
            <button className="secondary-button" onClick={addExperimentConfig}>
              Add Experiment
            </button>
          </div>

          <div className="grid-2">
            {adminConfig.experiments.map((experiment, experimentIndex) => (
              <article key={experiment.id} className="arm-card">
                <div className="panel-header-row">
                  <h3>{experiment.label || `Experiment ${experimentIndex + 1}`}</h3>
                  <button
                    className="danger-button small"
                    onClick={() => removeExperimentConfig(experimentIndex)}
                    disabled={adminConfig.experiments.length <= 1}
                  >
                    Remove
                  </button>
                </div>

                <label>
                  Experiment ID
                  <input
                    value={experiment.id}
                    onChange={(event) =>
                      updateExperimentField(experimentIndex, 'id', event.target.value)
                    }
                  />
                </label>

                <label>
                  Label
                  <input
                    value={experiment.label}
                    onChange={(event) =>
                      updateExperimentField(experimentIndex, 'label', event.target.value)
                    }
                  />
                </label>

                <label>
                  Enabled
                  <select
                    value={experiment.enabled ? 'yes' : 'no'}
                    onChange={(event) =>
                      updateExperimentField(experimentIndex, 'enabled', event.target.value === 'yes')
                    }
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>

                <div className="grid-3">
                  <label>
                    Number of arms
                    <input
                      type="number"
                      min={2}
                      max={20}
                      value={experiment.numArms}
                      onChange={(event) =>
                        updateExperimentNumArms(experimentIndex, Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Final rounds
                    <input
                      type="number"
                      min={5}
                      max={500}
                      value={experiment.finalRounds}
                      onChange={(event) =>
                        updateExperimentField(
                          experimentIndex,
                          'finalRounds',
                          Number(event.target.value)
                        )
                      }
                    />
                  </label>
                </div>

                <label>
                  Arm reward probabilities (0 to 1)
                  <div className="prob-grid">
                    {Array.from({ length: experiment.numArms }, (_, armIndex) => (
                      <label key={`${experiment.id}-prob-${armIndex}`} className="mini-label">
                        Arm {armIndex + 1}
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step="0.01"
                          value={experiment.armProbabilities[armIndex] ?? 0.5}
                          onChange={(event) =>
                            updateExperimentArmProbability(experimentIndex, armIndex, event.target.value)
                          }
                        />
                      </label>
                    ))}
                  </div>
                </label>
              </article>
            ))}
          </div>

          <label>
            Participant rule
            <div className="setup-note">
              Unlimited practice runs are allowed. Final runs are limited to one per experiment,
              with the global cap set above.
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

            <div className="setup-note">
              Total reward and the last reward for each arm are always shown to participants.
            </div>
          </div>

          <div className="grid-2">
            <article className="arm-card">
              <h3>Group A Details</h3>
              <label>
                Visibility mode
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
                Show full round history (round, arm, reward)
                <select
                  value={adminConfig.groupConfigs.A.showRoundHistory ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle('A', 'showRoundHistory', event.target.value === 'yes')
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show arm pull counts
                <select
                  value={adminConfig.groupConfigs.A.showArmPullCounts ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle('A', 'showArmPullCounts', event.target.value === 'yes')
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show current arm reward probabilities
                <select
                  value={adminConfig.groupConfigs.A.showCurrentArmProbabilities ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle(
                      'A',
                      'showCurrentArmProbabilities',
                      event.target.value === 'yes'
                    )
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show custom in-experiment instruction
                <select
                  value={adminConfig.groupConfigs.A.showCustomInstruction ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle(
                      'A',
                      'showCustomInstruction',
                      event.target.value === 'yes'
                    )
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Custom instruction text
                <textarea
                  rows={3}
                  value={adminConfig.groupConfigs.A.customInstruction}
                  onChange={(event) => updateGroupCustomInstruction('A', event.target.value)}
                />
              </label>
            </article>

            <article className="arm-card">
              <h3>Group B Details</h3>
              <label>
                Visibility mode
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

              <label>
                Show full round history (round, arm, reward)
                <select
                  value={adminConfig.groupConfigs.B.showRoundHistory ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle('B', 'showRoundHistory', event.target.value === 'yes')
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show arm pull counts
                <select
                  value={adminConfig.groupConfigs.B.showArmPullCounts ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle('B', 'showArmPullCounts', event.target.value === 'yes')
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show current arm reward probabilities
                <select
                  value={adminConfig.groupConfigs.B.showCurrentArmProbabilities ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle(
                      'B',
                      'showCurrentArmProbabilities',
                      event.target.value === 'yes'
                    )
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Show custom in-experiment instruction
                <select
                  value={adminConfig.groupConfigs.B.showCustomInstruction ? 'yes' : 'no'}
                  onChange={(event) =>
                    updateGroupDetailToggle(
                      'B',
                      'showCustomInstruction',
                      event.target.value === 'yes'
                    )
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <label>
                Custom instruction text
                <textarea
                  rows={3}
                  value={adminConfig.groupConfigs.B.customInstruction}
                  onChange={(event) => updateGroupCustomInstruction('B', event.target.value)}
                />
              </label>
            </article>
          </div>

          <div className="action-row">
            <button className="primary-button" onClick={saveAdminConfig} disabled={adminSaving}>
              {adminSaving ? 'Saving...' : 'Save All Settings'}
            </button>
          </div>

          <h3 className="admin-table-title">Recent Session Results</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Participant</th>
                  <th>Experiment</th>
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
                    <td>{row.experiment_id ?? '-'}</td>
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
