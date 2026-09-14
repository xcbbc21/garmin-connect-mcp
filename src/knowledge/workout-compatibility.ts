import { validateWorkoutDef, type WorkoutDef, type StepDef, type SimpleStepDef } from './workout-schema'

/** Convert the subset of Garmin's old DTO workout payload into the new model. */
export function normalizeLegacyWorkout(input: unknown): WorkoutDef {
  if (!isRecord(input)) throw new TypeError('Legacy workout must be an object')
  const name = stringField(input.workoutName ?? input.name, 'workoutName')
  const segment = Array.isArray(input.workoutSegments) ? input.workoutSegments[0] : undefined
  if (!isRecord(segment) || !Array.isArray(segment.workoutSteps)) {
    throw new TypeError('Legacy workout must contain workoutSegments[0].workoutSteps')
  }
  const steps = segment.workoutSteps.map((step, index) => normalizeStep(step, index))
  const result: WorkoutDef = {
    name,
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    sport: normalizeSport(input.sportType),
    steps,
  }
  const error = validateWorkoutDef(result)
  if (error) throw new TypeError(`Invalid legacy workout: ${error}`)
  return result
}

function normalizeStep(input: unknown, index: number): StepDef {
  if (!isRecord(input)) throw new TypeError(`Legacy workout step ${index + 1} must be an object`)
  if (input.type === 'RepeatGroupDTO') {
    if (!Array.isArray(input.workoutSteps)) throw new TypeError('RepeatGroupDTO must contain workoutSteps')
    return {
      type: 'repeat',
      iterations: numberField(input.numberOfIterations, 'numberOfIterations'),
      steps: input.workoutSteps.map((step, childIndex) => {
        const normalized = normalizeStep(step, childIndex)
        if (normalized.type === 'repeat') throw new TypeError('Nested RepeatGroupDTO is not supported')
        return normalized
      }),
    }
  }
  const stepType = stringField((input.stepType as Record<string, unknown> | undefined)?.stepTypeKey, 'stepTypeKey')
  const endConditionKey = stringField(
    (input.endCondition as Record<string, unknown> | undefined)?.conditionTypeKey,
    'conditionTypeKey',
  )
  const endCondition = endConditionKey === 'lap.button' ? 'lapButton' : endConditionKey
  if (!['warmup', 'interval', 'recovery', 'cooldown', 'rest'].includes(stepType)) {
    throw new TypeError(`Unsupported legacy step type "${stepType}"`)
  }
  if (!['distance', 'time', 'lapButton'].includes(endCondition)) {
    throw new TypeError(`Unsupported legacy end condition "${endConditionKey}"`)
  }
  const targetKey = (input.targetType as Record<string, unknown> | undefined)?.workoutTargetTypeKey
  const step: SimpleStepDef = {
    type: stepType as SimpleStepDef['type'],
    endCondition: endCondition as SimpleStepDef['endCondition'],
    target: targetKey === 'pace.zone' ? 'pace' : targetKey === 'heart.rate.zone' ? 'heartRate' : 'open',
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(endCondition !== 'lapButton' && typeof input.endConditionValue === 'number'
      ? { endValue: input.endConditionValue } : {}),
  }
  if (step.target === 'pace') {
    step.paceFrom = mpsToPace(numberField(input.targetValueOne, 'targetValueOne'))
    step.paceTo = mpsToPace(numberField(input.targetValueTwo, 'targetValueTwo'))
  }
  if (step.target === 'heartRate') {
    if (typeof input.zoneNumber === 'number') step.hrZone = input.zoneNumber
    else {
      step.hrFrom = numberField(input.targetValueOne, 'targetValueOne')
      step.hrTo = numberField(input.targetValueTwo, 'targetValueTwo')
    }
  }
  return step
}

function normalizeSport(value: unknown): WorkoutDef['sport'] {
  const key = isRecord(value) ? value.sportTypeKey : undefined
  if (key === 'running' || key === 'cycling' || key === 'swimming') return key
  if (key === 'strength_training') return 'strength'
  return 'running'
}

function mpsToPace(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Legacy pace target must be positive')
  const seconds = Math.max(1, Math.round(1000 / value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Legacy ${name} is required`)
  return value
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Legacy ${name} must be a finite number`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
