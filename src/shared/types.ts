export type ConversationMode = 'companion' | 'assistant';
export type Trigger = 'direct' | 'continuation' | 'ambient';
export type ToolId =
  | 'memory_search'
  | 'memory_remember'
  | 'skills_load'
  | 'read_file'
  | 'write_file'
  | 'web_read'
  | 'sandbox_exec'
  | 'qzone_publish';
export type Phase =
  | 'idle'
  | 'queued'
  | 'collecting'
  | 'recalling'
  | 'generating'
  | 'tool'
  | 'approval'
  | 'sending'
  | 'cancelled'
  | 'error';

export interface MessageEnvelope {
  id: string;
  conversationId: string;
  channel: 'desktop' | 'onebot';
  actorId: string;
  displayName: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  trigger: Trigger;
  replyTo?: string;
  quoted?: { actorId: string; text: string };
  mention: boolean;
}
export interface ConversationSettings {
  mode: ConversationMode;
  ambient: boolean;
  muted: boolean;
}
export interface ModelProfile {
  protocol: 'openai-completions';
  provider: 'deepseek' | 'openai-compatible';
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: 'off' | 'low' | 'high';
  keyRequired: boolean;
}
export interface AppConfig {
  version: 1;
  revision: number;
  enabled: boolean;
  persona: string;
  model: ModelProfile;
  onebot: {
    enabled: boolean;
    url: string;
    botQQ: string;
    ownerQQ: string;
    users: string[];
    groups: string[];
  };
  tools: Record<ToolId, boolean>;
  conversations: Record<string, ConversationSettings>;
  memory: { automatic: boolean; extractionDelayMs: number; dailyTokenBudget: number };
  limits: {
    foreground: number;
    perRoomPending: number;
    totalPending: number;
    maxLiveRooms: number;
    idleRoomMs: number;
    runTimeoutMs: number;
    ambientChecksPerHour: number;
    ambientRepliesPerHour: number;
    ambientTokenBudget: number;
  };
  sandbox: { image: string; timeoutMs: number; memoryMb: number; cpus: number; pids: number };
}
export interface RunContext {
  id: string;
  conversationId: string;
  actorId: string;
  isGroup: boolean;
  channel: MessageEnvelope['channel'];
  trigger: Trigger;
  sourceIds: string[];
  mode: ConversationMode;
  startedAt: number;
}
export interface CapabilitySnapshot {
  revision: number;
  mode: ConversationMode;
  tools: { id: ToolId; description: string; approval: boolean }[];
  workspace: string;
  skills: SkillInfo[];
  actorIsOwner: boolean;
}
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  revision: string;
  resources: string[];
}
export interface MemoryFact {
  id: string;
  scope: string;
  subject: string;
  content: string;
  kind: 'identity' | 'preference' | 'event' | 'plan' | 'relationship';
  sourceIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface ConversationRow {
  id: string;
  name: string;
  isGroup: boolean;
  updatedAt: number;
  unread: number;
  phase: Phase;
  draft?: string;
  error?: string;
  settings: ConversationSettings;
}
export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'notice';
  actorId: string;
  name: string;
  text: string;
  timestamp: number;
  replyTo?: string;
  status?: 'pending' | 'sent' | 'unknown' | 'failed';
}
export interface Approval {
  id: string;
  runId: string;
  conversationId: string;
  tool: ToolId;
  summary: string;
  detail: string;
  expiresAt: number;
  revision: number;
  digest: string;
}
export interface Activity {
  id: string;
  runId?: string;
  conversationId?: string;
  timestamp: number;
  type: string;
  text: string;
}
export interface RuntimeEvent {
  seq: number;
  timestamp: number;
  conversationId?: string;
  runId?: string;
  type: 'change' | 'phase' | 'draft' | 'activity' | 'usage';
  data: unknown;
}
export interface AppSnapshot {
  config: AppConfig;
  keyConfigured: boolean;
  onebotTokenConfigured: boolean;
  vaultAvailable: boolean;
  connection: string;
  account?: string;
  rooms: ConversationRow[];
  approvals: Approval[];
  activities: Activity[];
  memoryCount: number;
  usage: { input: number; output: number; ambient: number; background: number };
  sandbox: { available: boolean; reason?: string };
  testMode: boolean;
  friendRequests: { id: string; qq: string; comment: string }[];
  loginStartup: boolean;
}
export interface SettingsChange {
  config?: Partial<Omit<AppConfig, 'version' | 'revision'>>;
  apiKey?: string;
  clearApiKey?: boolean;
  onebotToken?: string;
  clearOnebotToken?: boolean;
}
export interface ChatDSApi {
  state(): Promise<AppSnapshot>;
  configure(change: SettingsChange): Promise<AppSnapshot>;
  chat(text: string): Promise<void>;
  history(conversationId: string, before?: number): Promise<ChatMessage[]>;
  conversation(id: string, settings: Partial<ConversationSettings>): Promise<void>;
  stop(conversationId?: string): Promise<void>;
  memories(scope?: string): Promise<MemoryFact[]>;
  forget(id: string): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  approveFriend(id: string): Promise<void>;
  modelTest(): Promise<{ ok: boolean; detail: string }>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sandboxCheck(): Promise<{ available: boolean; reason?: string }>;
  chooseSkill(): Promise<void>;
  removeSkill(id: string): Promise<void>;
  skills(): Promise<SkillInfo[]>;
  chooseImport(): Promise<{ messages: number; memories: number; archived: number } | null>;
  openData(): Promise<void>;
  loginStartup(enabled: boolean): Promise<boolean>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
declare global {
  interface Window {
    chatds: ChatDSApi;
  }
}
