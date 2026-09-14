import { LegacyGarminReadAdapter, type LegacyGarminReadTransport } from '../src/read-adapters/legacy-garmin'
import { GarminClient } from '../src/client'

class FakeGarminTransport implements LegacyGarminReadTransport {
  readonly requests: string[] = []

  constructor(private readonly responses: Record<string, unknown>) {}

  async get<T>(path: string): Promise<T> {
    this.requests.push(path)
    return this.responses[path] as T
  }
}

describe('legacy Garmin read adapter', () => {
  it('builds the activity split endpoint through the new client transport', async () => {
    const transport = new FakeGarminTransport({
      'activity-service/activity/123/splits': { splits: [{ distance: 1 }] },
    })
    const adapter = new LegacyGarminReadAdapter(transport)

    await expect(adapter.getActivitySplits('123')).resolves.toEqual({
      splits: [{ distance: 1 }],
    })
    expect(transport.requests).toEqual(['activity-service/activity/123/splits'])
  })

  it('keeps the four activity detail endpoint paths separate', async () => {
    const transport = new FakeGarminTransport({
      'activity-service/activity/123/hrTimeInZones': { zones: [] },
      'activity-service/activity/123/polyline/full-resolution/': { polyline: [] },
      'activity-service/activity/123/weather': { weather: {} },
    })
    const adapter = new LegacyGarminReadAdapter(transport)

    await adapter.getActivityHrZones('123')
    await adapter.getActivityPolyline('123')
    await adapter.getActivityWeather('123')

    expect(transport.requests).toEqual([
      'activity-service/activity/123/hrTimeInZones',
      'activity-service/activity/123/polyline/full-resolution/',
      'activity-service/activity/123/weather',
    ])
  })

  it('rejects blank activity IDs before transport dispatch', async () => {
    const transport = new FakeGarminTransport({})
    const adapter = new LegacyGarminReadAdapter(transport)

    await expect(adapter.getActivitySplits('  ')).rejects.toThrow('Invalid activityId')
    expect(transport.requests).toEqual([])
  })

  it('exposes a dedicated legacy read method on the new client', () => {
    expect(typeof (GarminClient.prototype as unknown as { getLegacy?: unknown }).getLegacy)
      .toBe('function')
  })
})
