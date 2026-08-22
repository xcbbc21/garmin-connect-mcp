import {
  parseGarminAuthCancelRpcResult,
  parseGarminAuthStatusRpcResult,
} from './protocol'

const RPC_CHANNEL = '/garmin-auth'

interface RpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/**
 * Release a flow handle only after the Host confirms cancellation or a
 * terminal status. An uncertain transport result deliberately keeps the
 * handle so a retry cannot accidentally start a second flow.
 */
export async function releaseGarminAuthFlow(
  rpc: RpcCaller,
  flowId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const cancelled = parseGarminAuthCancelRpcResult(
      await rpc.call(RPC_CHANNEL, 'cancel', { flowId }, signal),
    )
    if (cancelled.success) return true
  } catch {
    // Cancellation may have reached the Host. Confirm through coarse status.
  }

  try {
    const status = parseGarminAuthStatusRpcResult(
      await rpc.call(RPC_CHANNEL, 'status', { flowId }, signal),
    )
    return status.success && status.status !== 'in_progress'
  } catch {
    return false
  }
}

/** Preserve a late begin result unless its cleanup was positively confirmed. */
export function retainUnreleasedGarminAuthFlowId(
  currentFlowId: string | undefined,
  candidateFlowId: string,
  released: boolean,
): string | undefined {
  if (released) return currentFlowId
  return currentFlowId ?? candidateFlowId
}
