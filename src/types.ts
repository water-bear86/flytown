export type CreatureKind =
  | "goblin"
  | "gremlin"
  | "raccoon"
  | "troll"
  | "ogre"
  | "pigeon";

export const CREATURE_KINDS: CreatureKind[] = [
  "goblin",
  "gremlin",
  "raccoon",
  "troll",
  "ogre",
  "pigeon",
];

export type Personality =
  | "nerdy"
  | "cynical"
  | "chipper"
  | "stoic"
  | "feral"
  | "goblin_mode";

export interface Creature {
  kind: CreatureKind;
  modelSlot?: ModelSlot;
  model: string;
  temperature: number;
  personality: Personality;
  systemPrompt: string;
}

export interface DriftReport {
  creatureMentions: Record<CreatureKind, number>;
  totalCreatureWords: number;
  outputWordCount: number;
  driftRate: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface Loot {
  id: string;
  questId?: string;
  riteId?: string;
  creatureKind: CreatureKind;
  personality: Personality;
  model: string;
  prompt: string;
  output: string;
  reward?: number;
  parentLootIds?: string[];
  timestamp: number;
  drift: DriftReport;
  usage?: TokenUsage;
}

export interface TrollVerdict {
  lootId: string;
  passed: boolean;
  score: number;
  critique: string;
}

export interface Quest {
  id: string;
  task: string;
  packSize: number;
  personality: Personality;
  lootIds: string[];
  trollVerdicts: Record<string, TrollVerdict>;
  winnerLootId?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface Rite {
  id: string;
  task: string;
  scanGlobs: string[];
  packSize: number;
  personality: Personality;
  contextLootId?: string;
  goblinLootIds: string[];
  chaosLootIds: Record<string, string>;
  trollVerdicts: Record<string, TrollVerdict>;
  ogreLootId?: string;
  winnerLootId?: string;
  /** Specialist-recovery loot ids (Phase 2). */
  specialistLootIds?: string[];
  /** Verdicts for specialist outputs (keyed by specialist loot id). */
  specialistVerdicts?: Record<string, TrollVerdict>;
  outcome: "winner" | "specialist_recovery" | "ogre_fallback" | "all_failed";
  startedAt: number;
  finishedAt?: number;
}

export interface InboxMessage {
  id: string;
  fromWarren: string;
  audience: string;
  body: string;
  signature: string;
  sourceLootId: string;
  receivedAt: number;
}

export interface OutboxRecord {
  id: string;
  toWarren: string;
  audience: string;
  sourceLootId: string;
  pigeonLootId: string;
  signature: string;
  sentAt: number;
}

export interface FriendRecord {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  createdAt: string;
  note?: string;
}

export interface FriendRequest {
  id: string;
  fromName: string;
  fromUrl: string;
  fromPublicKey: string;
  toName: string;
  toUrl: string;
  createdAt: string;
  signature: string;
}

export interface DirectMessage {
  id: string;
  threadId: string;
  fromName: string;
  fromUrl: string;
  fromPublicKey: string;
  toName: string;
  toUrl: string;
  body: string;
  createdAt: string;
  signature: string;
  readAt?: string;
}

export interface DirectMessageThread {
  id: string;
  participantA: string;
  participantB: string;
  updatedAt: string;
  lastMessagePreview: string;
}

/**
 * An Artifact is a typed, structured summary of what a Rite established.
 * Stored separately from raw Loot so that future rites can load just the
 * distilled findings without re-reading every prompt/output.
 */
export interface Artifact {
  /** Stable id derived from rite id + content hash. */
  id: string;
  riteId: string;
  task: string;
  outcome: Rite["outcome"];
  /** Pointer to the winning loot (whose output the artifact distills). */
  winnerLootId?: string;

  /** Things this rite established. */
  claims: ArtifactClaim[];
  /** Pointers to evidence backing the claims. */
  evidence: ArtifactEvidence[];
  /** Things the rite identified but didn't resolve. */
  openQuestions: string[];
  /** Suggested follow-up rites. */
  nextSteps: string[];

  /** Other artifacts this rite built on (parent → child memory chain). */
  parentArtifactIds: string[];

  /** Keywords for v1 retrieval. */
  keywords: string[];
  /** Optional embedding for v2 retrieval. */
  embedding?: number[];

  timestamp: number;
}

export interface ArtifactClaim {
  text: string;
  confidence: "established" | "likely" | "speculative";
  /** Indexes into Artifact.evidence. */
  evidenceIds?: number[];
}

export interface ArtifactEvidence {
  kind: "loot" | "file" | "url" | "external";
  ref: string;
  snippet?: string;
}

/**
 * A Plan is a DAG of sub-rites the Planner emits for complex tasks.
 * Topologically executed; failed nodes can trigger recursive replan.
 */
export interface Plan {
  id: string;
  rootTask: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** How many times the planner has been re-invoked on this plan (max 2). */
  replanDepth: number;
  createdAt: number;
  /**
   * Optional: the planner decided not to run any nodes. The executor honours
   * this before validation and returns a "halted" result. Lets a planner
   * backend express "stop", "blocked" or "needs approval" without inventing
   * a fake sub-rite.
   */
  halt?: PlanHalt;
  /** Which planner backend produced this plan (e.g. "llm", "rules", "fly"). */
  plannerId?: string;
}

export interface PlanHalt {
  kind: "success" | "blocked" | "approval";
  reason: string;
}

export interface PlanNode {
  id: string;
  task: string;
  /** ids of nodes whose artifacts must be available before this node runs. */
  inputs: string[];
  kind: "sub_rite" | "synthesize";
  /** Suggested pack size from dynamic spawning; defaults to 1 if absent. */
  packSize?: number;
  /** Suggested lead personality for the goblin pack on this node. */
  personality?: Personality;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  riteId?: string;
  artifactId?: string;
  failureReason?: string;
  /** Optional planner hints (orchestration action that produced this node, etc). */
  hints?: PlanNodeHints;
}

export interface PlanNodeHints {
  /** Orchestration action this node was compiled from. */
  action?: string;
  /** Ask the troll to use verifier tools while reviewing this node. */
  trollTools?: boolean;
  /** Run an inter-goblin debate round on this node. */
  debate?: boolean;
}

export interface PlanEdge {
  from: string;
  to: string;
}

/**
 * Identified failure mode across a pack of failed goblin attempts.
 * Used to spawn focused Specialist goblins in the recovery layer.
 */
export interface FailureCluster {
  /** Short identifier, e.g. "null-handling". */
  name: string;
  /** 1-2 sentence description of what's wrong. */
  description: string;
  /** Indexes into the goblin pack that exhibit this failure. */
  affectedGoblinIndexes: number[];
  /** Concise instruction for the specialist goblin telling it what to fix. */
  specialistFocus: string;
  severity: "high" | "medium" | "low";
}

export type ModelSlot = CreatureKind | "scribe" | "embedding";

export type ProviderPresetId =
  | "openai"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "groq"
  | "together"
  | "mistral"
  | "deepseek"
  | "anthropic"
  | "gemini"
  | "custom";

export type OutputFormat = "freeform" | "markdown" | "json";

export interface ProviderRouteConfig {
  preset: ProviderPresetId;
  baseURL?: string;
  apiKeyEnv?: string;
  model?: string;
  outputFormat?: OutputFormat;
}

export interface ProviderConfig {
  preset: ProviderPresetId;
  baseURL?: string;
  apiKeyEnv?: string;
  models?: Partial<Record<ModelSlot, string>>;
  routes?: Partial<Record<ModelSlot, ProviderRouteConfig>>;
  outputFormat?: OutputFormat;
  /**
   * Extra fields merged into every chat-completion request for this provider,
   * e.g. `{ "thinking": { "type": "disabled" } }` to stop a reasoning model
   * from spending the output budget on hidden reasoning.
   */
  requestParams?: Record<string, unknown>;
}

export interface OnboardingConfig {
  version?: number;
  dismissedAt?: string;
}

export interface WarrenManifest {
  name: string;
  version: number;
  createdAt: string;
  defaultModelGoblin: string;
  defaultModelOgre: string;
  defaultModelTroll: string;
  provider?: ProviderConfig;
  onboarding?: OnboardingConfig;
  /** FLYTOWN planner configuration. Absent = conventional LLM planner. */
  flytown?: FlytownConfig;
}

export interface FlytownConfig {
  /** Planner backend id: "llm" (default) | "rules" | "random" | "fly" | "fly:shuffled" | ... */
  planner?: string;
  /** Connectome artifact id (directory under connectome/). */
  connectome?: string;
  /** Fall back to the LLM planner if the fly planner errors. Default true. */
  fallbackToLlm?: boolean;
  /** Enable reward-modulated adapter learning. Default false. */
  learning?: boolean;
  /** Deterministic seed for planner randomness. */
  seed?: number;
}
