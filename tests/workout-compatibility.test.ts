import { normalizeLegacyWorkout } from '../src/knowledge/workout-compatibility'

describe('legacy workout compatibility', () => {
  it('converts the old Garmin DTO shape into the new strict workout definition', () => {
    expect(normalizeLegacyWorkout({
      workoutName: 'Legacy tempo',
      sportType: { sportTypeKey: 'running' },
      workoutSegments: [{ workoutSteps: [
        {
          type: 'ExecutableStepDTO',
          stepType: { stepTypeKey: 'warmup' },
          endCondition: { conditionTypeKey: 'time' },
          endConditionValue: 600,
          targetType: { workoutTargetTypeKey: 'no.target' },
        },
        {
          type: 'RepeatGroupDTO',
          numberOfIterations: 3,
          workoutSteps: [{
            type: 'ExecutableStepDTO',
            stepType: { stepTypeKey: 'interval' },
            endCondition: { conditionTypeKey: 'distance' },
            endConditionValue: 1000,
          }],
        },
      ] }],
    })).toEqual({
      name: 'Legacy tempo',
      sport: 'running',
      steps: [
        { type: 'warmup', endCondition: 'time', endValue: 600, target: 'open' },
        { type: 'repeat', iterations: 3, steps: [
          { type: 'interval', endCondition: 'distance', endValue: 1000, target: 'open' },
        ] },
      ],
    })
  })

  it('rejects unsupported DTO shapes before any write can be attempted', () => {
    expect(() => normalizeLegacyWorkout({ workoutName: 'bad', workoutSegments: [] }))
      .toThrow('workoutSteps')
  })
})
