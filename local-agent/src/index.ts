import type { LocalArchivePort, ResumeRequest, ResumeDecision } from '@sakie/contracts';
/** Boundary only: does not open a socket, database, HTTP port, or background timer. */
export interface LocalAgentBoundary {
  readonly archive: LocalArchivePort;
  reconcile(request: ResumeRequest): Promise<ResumeDecision>;
}
