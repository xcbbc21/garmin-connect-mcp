import {
  releaseGarminAuthFlow,
  retainUnreleasedGarminAuthFlowId,
} from '../src/client/flow-control'

const flowId = 'a'.repeat(64)

describe('DSH Garmin authentication flow control', () => {
  it('releases a previous handle only after cancellation is confirmed', async () => {
    const call = jest.fn().mockResolvedValue({
      ok: true,
      value: { success: true },
    })

    await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      '/garmin-auth',
      'cancel',
      { flowId },
      undefined,
    )
  })

  it('keeps the handle when cancellation and status are uncertain', async () => {
    const call = jest.fn()
      .mockRejectedValueOnce(new Error('transport failed with ST-secret'))
      .mockResolvedValueOnce({
        ok: true,
        value: { success: true, status: 'in_progress' },
      })

    await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(false)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'expired'] as const)(
    'releases a terminal flow after cancellation returns an ambiguous result: %s',
    async (status) => {
      const call = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { success: false, code: 'unavailable' },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: { success: true, status },
        })

      await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(true)
      expect(call).toHaveBeenCalledTimes(2)
    },
  )

  it('retains a late begin handle only when its release is uncertain', () => {
    const existingFlowId = 'b'.repeat(64)

    expect(retainUnreleasedGarminAuthFlowId(undefined, flowId, false)).toBe(flowId)
    expect(retainUnreleasedGarminAuthFlowId(existingFlowId, flowId, false))
      .toBe(existingFlowId)
    expect(retainUnreleasedGarminAuthFlowId(undefined, flowId, true)).toBeUndefined()
  })
})
