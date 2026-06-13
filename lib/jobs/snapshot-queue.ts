import { Queue } from 'bullmq'
import { getEnv } from '@/lib/env'

export const SNAPSHOT_QUEUE = 'workspace-snapshot'

export interface SnapshotJob {
  snapshotRunId: string
}

export function snapshotJobPayload(snapshotRunId: string): SnapshotJob {
  return { snapshotRunId }
}

let queue: Queue | undefined
export function getSnapshotQueue(): Queue<SnapshotJob> {
  if (!queue) {
    queue = new Queue<SnapshotJob>(SNAPSHOT_QUEUE, {
      connection: { url: getEnv().REDIS_URL, maxRetriesPerRequest: null },
    })
  }
  return queue as Queue<SnapshotJob>
}

export async function enqueueSnapshot(snapshotRunId: string): Promise<void> {
  await getSnapshotQueue().add('snapshot', snapshotJobPayload(snapshotRunId), {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  })
}
