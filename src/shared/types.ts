export type TaskStatus = 'pending' | 'reasoning' | 'acting' | 'validating' | 'succeeded' | 'failed'
export interface ModelConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxRetries: number }
export interface TaskStep { id: string; phase: 'reason' | 'skill' | 'act' | 'validate'; title: string; detail: string; timestamp: string }
export interface AgentTask { id: string; prompt: string; status: TaskStatus; result?: string; error?: string; createdAt: string; steps: TaskStep[] }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; completedAt?: string; status?: TaskStatus; steps?: TaskStep[] }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }
export interface AppSettings { model: ModelConfig; mcpUrl: string; skillsEnabled: boolean }
export interface AgentPolicy { systemPrompt: string; workspacePath: string; enabledTools: string[] }
export interface ConnectionTestResult { ok: boolean; message: string }
export interface AgentStepEvent { conversationId: string; messageId: string; step: TaskStep }
export interface AgentDeltaEvent { conversationId: string; messageId: string; delta: string }
export interface AgentDoneEvent { conversationId: string; messageId: string; status: TaskStatus; content: string; completedAt: string }
export interface AgentRunResult { conversation: Conversation; task: AgentTask }
export interface DesktopApi {
  runTask(conversationId: string, prompt: string): Promise<AgentRunResult>
  getConversations(): Promise<Conversation[]>
  createConversation(): Promise<Conversation>
  deleteConversation(conversationId: string): Promise<Conversation[]>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  testConnection(settings: AppSettings): Promise<ConnectionTestResult>
  getPolicy(): Promise<AgentPolicy>
  savePolicy(policy: AgentPolicy): Promise<AgentPolicy>
  onAgentStep(callback: (event: AgentStepEvent) => void): () => void
  onAgentDelta(callback: (event: AgentDeltaEvent) => void): () => void
  onAgentDone(callback: (event: AgentDoneEvent) => void): () => void
}
