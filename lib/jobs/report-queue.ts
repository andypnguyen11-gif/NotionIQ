// lib/jobs/report-queue.ts
import { Queue } from 'bullmq'
import { getEnv } from '@/lib/env'

export const REPORT_QUEUE = 'workspace-report'

export type ReportMode = 'full' | 'write_only'
export interface ReportJob {
  reportRunId: string
  mode: ReportMode
}

export function reportJobPayload(reportRunId: string, mode: ReportMode = 'full'): ReportJob {
  return { reportRunId, mode }
}

let queue: Queue<ReportJob> | undefined
export function getReportQueue(): Queue<ReportJob> {
  if (!queue) {
    queue = new Queue<ReportJob>(REPORT_QUEUE, { connection: { url: getEnv().REDIS_URL, maxRetriesPerRequest: null } })
  }
  return queue
}

export async function enqueueReport(reportRunId: string, mode: ReportMode = 'full'): Promise<void> {
  await getReportQueue().add('report', reportJobPayload(reportRunId, mode), { attempts: 1, removeOnComplete: true, removeOnFail: false })
}
