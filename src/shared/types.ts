export type TaskStatus = 'pending' | 'reasoning' | 'acting' | 'validating' | 'succeeded' | 'failed' | 'paused'
export type AgentArtifact = { type: 'file'; path: string } | { type: 'service'; url: string }
export interface ModelConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxRetries: number }
export interface ModelProfile extends ModelConfig { id: string; name: string; provider?: string }
export interface NavigationSettings { fileApplicationPath: string; browserApplicationPath: string }
export interface TaskStep { id: string; phase: 'reason' | 'skill' | 'act' | 'validate'; title: string; detail: string; timestamp: string }
export interface TokenUsage { inputTokens: number; outputTokens: number; durationMs: number; estimated: boolean }
export interface AgentTask { id: string; prompt: string; status: TaskStatus; result?: string; error?: string; createdAt: string; steps: TaskStep[]; artifacts?: AgentArtifact[]; tokenUsage?: TokenUsage }
export interface ChatAttachment { id: string; name: string; mimeType: string; size: number; dataUrl: string; workspacePath?: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[]; createdAt: string; completedAt?: string; status?: TaskStatus; steps?: TaskStep[]; artifacts?: AgentArtifact[]; tokenUsage?: TokenUsage }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; workspacePath?: string; activeAttachments?: ChatAttachment[]; modelId?: string }
export interface AppSettings { model: ModelConfig; models?: ModelProfile[]; defaultModelId?: string; skillsEnabled: boolean; navigation: NavigationSettings }
export interface AgentPolicy { systemPrompt: string; workspacePath: string; enabledTools: string[] }
export interface ConnectionTestResult { ok: boolean; message: string }
export interface NavigationResult { ok: boolean; message?: string }
export interface AgentStepEvent { conversationId: string; messageId: string; step: TaskStep }
export interface AgentDeltaEvent { conversationId: string; messageId: string; delta: string }
export interface AgentDoneEvent { conversationId: string; messageId: string; status: TaskStatus; content: string; completedAt: string; tokenUsage?: TokenUsage }
export interface AgentRunResult { conversation: Conversation; task: AgentTask }
export interface McpApprovalDetails { toolName: string; serverUrl: string; path?: string; workspacePath?: string; conversationId?: string }
export interface McpApprovalRequest extends McpApprovalDetails { id: string; expiresAt: string }
export interface CommandApprovalDetails { command: string; args: string[]; displayCommand: string; reason: string; workspacePath?: string; conversationId?: string }
export interface CommandApprovalRequest extends CommandApprovalDetails { id: string; expiresAt: string }
export interface UserChoiceOption { id: string; label: string; description?: string; workspacePath?: string }
export interface UserChoiceDetails { title: string; description?: string; options: UserChoiceOption[]; conversationId?: string }
export interface UserChoiceRequest extends UserChoiceDetails { id: string; expiresAt: string }
export interface DesktopApi {
  runTask(conversationId: string, prompt: string, attachments?: ChatAttachment[]): Promise<AgentRunResult>
  cancelTask(conversationId: string): void
  getConversations(): Promise<Conversation[]>
  createConversation(): Promise<Conversation>
  deleteConversation(conversationId: string): Promise<Conversation[]>
  selectConversationWorkspace(conversationId: string): Promise<Conversation>
  resetConversationWorkspace(conversationId: string): Promise<Conversation>
  removeConversationAttachment(conversationId: string, attachmentId: string): Promise<Conversation>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  testConnection(settings: AppSettings, modelId?: string): Promise<ConnectionTestResult>
  setConversationModel(conversationId: string, modelId?: string): Promise<Conversation>
  selectApplication(kind: 'file' | 'browser'): Promise<string | undefined>
  getPolicy(): Promise<AgentPolicy>
  savePolicy(policy: AgentPolicy): Promise<AgentPolicy>
  copyText(text: string): void
  openWorkspaceFile(conversationId: string, path: string): Promise<NavigationResult>
  openExternalUrl(url: string): Promise<NavigationResult>
  onAgentStep(callback: (event: AgentStepEvent) => void): () => void
  onAgentDelta(callback: (event: AgentDeltaEvent) => void): () => void
  onAgentDone(callback: (event: AgentDoneEvent) => void): () => void
  onMcpApprovalRequest(callback: (request: McpApprovalRequest) => void): () => void
  respondMcpApproval(requestId: string, approved: boolean): void
  onCommandApprovalRequest(callback: (request: CommandApprovalRequest) => void): () => void
  respondCommandApproval(requestId: string, approved: boolean): void
  onUserChoiceRequest(callback: (request: UserChoiceRequest) => void): () => void
  respondUserChoice(requestId: string, optionId?: string): void
}
