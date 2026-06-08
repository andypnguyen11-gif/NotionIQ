import { Queue } from 'bullmq'
import { getEnv } from '@/lib/env'

export const SCAN_QUEUE = 'workspace-scan'

export interface ScanJob {
  scanRunId: string
}

export function scanJobPayload(scanRunId: string): ScanJob {
  return { scanRunId }
}

let queue: Queue | undefined
export function getScanQueue(): Queue<ScanJob> {
  if (!queue) {
    queue = new Queue<ScanJob>(SCAN_QUEUE, {
      connection: { url: getEnv().REDIS_URL, maxRetriesPerRequest: null },
    })
  }
  return queue as Queue<ScanJob>
}

export async function enqueueScan(scanRunId: string): Promise<void> {
  await getScanQueue().add('scan', scanJobPayload(scanRunId), {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  })
}
