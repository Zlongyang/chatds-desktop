import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { CapabilitySnapshot, RunContext, ToolId } from '../shared/types.js';
export interface RuntimeHost {
  register(runId: string, sourceIds: string[], conversationId: string): Promise<RunContext>;
  capabilities(runId: string): Promise<CapabilitySnapshot>;
  tool(runId: string, tool: ToolId, args: unknown, signal: AbortSignal): Promise<unknown>;
  send(runId: string, text: string, outboxId: string, signal: AbortSignal): Promise<string>;
  finish(runId: string): Promise<void>;
  stream(runId: string, budget?: number, thinking?: 'off' | 'low' | 'high'): StreamFn;
}
