/**
 * The role a model-backed worker plays (see docs/flytown/VOCABULARY.md):
 * forager (parallel candidate answers), wasp (adversarial attack on a
 * candidate), scout (context gathering), guard (default-reject review),
 * soldier (expensive escalation), messenger (compression; in Scribe mode it
 * distils a finished flight into an Artifact).
 */
export type Caste =
  | "forager"
  | "wasp"
  | "scout"
  | "guard"
  | "soldier"
  | "messenger";

export const CASTES: Caste[] = [
  "forager",
  "wasp",
  "scout",
  "guard",
  "soldier",
  "messenger",
];

export type Personality =
  | "nerdy"
  | "cynical"
  | "chipper"
  | "stoic"
  | "feral"
  | "frenzied";

/** A model-backed worker: one caste, one model, one system prompt. */
export interface Insect {
  caste: Caste;
  modelSlot?: ModelSlot;
  model: string;
  temperature: number;
  personality: Personality;
  systemPrompt: string;
}

/** How often an output mentions the caste names (detects the themed prompts leaking into outputs). */
export interface DriftReport {
  casteMentions: Record<Caste, number>;
  totalCasteWords: number;
  outputWordCount: number;
  driftRate: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

/** One model invocation (prompt, output, usage), content-addressed in the Compost. */
export interface Morsel {
  id: string;
  forayId?: string;
  flightId?: string;
  caste: Caste;
  personality: Personality;
  model: string;
  prompt: string;
  output: string;
  reward?: number;
  parentMorselIds?: string[];
  timestamp: number;
  drift: DriftReport;
  usage?: TokenUsage;
}

/** The guard's pass/fail verdict and 0-1 score for one candidate morsel. */
export interface GuardVerdict {
  morselId: string;
  passed: boolean;
  score: number;
  critique: string;
}

/** Lightweight run: a forager swarm plus guard review, without the full flight pipeline. */
export interface Foray {
  id: string;
  task: string;
  swarmSize: number;
  personality: Personality;
  morselIds: string[];
  guardVerdicts: Record<string, GuardVerdict>;
  winnerMorselId?: string;
  startedAt: number;
  finishedAt?: number;
}

/** The full pipeline: scout → forager swarm → wasps → guard → specialists → soldier → scribe. */
export interface Flight {
  id: string;
  task: string;
  scanGlobs: string[];
  swarmSize: number;
  personality: Personality;
  contextMorselId?: string;
  foragerMorselIds: string[];
  stingMorselIds: Record<string, string>;
  guardVerdicts: Record<string, GuardVerdict>;
  soldierMorselId?: string;
  winnerMorselId?: string;
  /** Specialist-recovery morsel ids (Phase 2). */
  specialistMorselIds?: string[];
  /** Verdicts for specialist outputs (keyed by specialist morsel id). */
  specialistVerdicts?: Record<string, GuardVerdict>;
  outcome: "winner" | "specialist_recovery" | "soldier_fallback" | "all_failed";
  startedAt: number;
  finishedAt?: number;
}

export interface InboxMessage {
  id: string;
  fromTerrarium: string;
  audience: string;
  body: string;
  signature: string;
  sourceMorselId: string;
  receivedAt: number;
}

export interface OutboxRecord {
  id: string;
  toTerrarium: string;
  audience: string;
  sourceMorselId: string;
  messengerMorselId: string;
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
 * An Artifact is a typed, structured summary of what a Flight established.
 * Stored separately from raw morsels so that future flights can load just the
 * distilled findings without re-reading every prompt/output.
 */
export interface Artifact {
  /** Stable id derived from flight id + content hash. */
  id: string;
  flightId: string;
  task: string;
  outcome: Flight["outcome"];
  /** Pointer to the winning morsel (whose output the artifact distills). */
  winnerMorselId?: string;

  /** Things this flight established. */
  claims: ArtifactClaim[];
  /** Pointers to evidence backing the claims. */
  evidence: ArtifactEvidence[];
  /** Things the flight identified but didn't resolve. */
  openQuestions: string[];
  /** Suggested follow-up flights. */
  nextSteps: string[];

  /** Other artifacts this flight built on (parent → child memory chain). */
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
  kind: "morsel" | "file" | "url" | "external";
  ref: string;
  snippet?: string;
}

/**
 * A Plan is a DAG of flights the Planner emits for complex tasks.
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
   * a fake flight.
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
  kind: "flight" | "synthesize";
  /** Suggested swarm size from dynamic spawning; defaults to 1 if absent. */
  swarmSize?: number;
  /** Suggested lead personality for the forager swarm on this node. */
  personality?: Personality;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  flightId?: string;
  artifactId?: string;
  failureReason?: string;
  /** Optional planner hints (orchestration action that produced this node, etc). */
  hints?: PlanNodeHints;
}

export interface PlanNodeHints {
  /** Orchestration action this node was compiled from. */
  action?: string;
  /** Ask the guard to use verifier tools while reviewing this node. */
  guardTools?: boolean;
  /** Run an inter-forager debate round on this node. */
  debate?: boolean;
}

export interface PlanEdge {
  from: string;
  to: string;
}

/**
 * Identified failure mode across a swarm of failed forager attempts.
 * Used to spawn focused Specialist foragers in the recovery layer.
 */
export interface FailureCluster {
  /** Short identifier, e.g. "null-handling". */
  name: string;
  /** 1-2 sentence description of what's wrong. */
  description: string;
  /** Indexes into the forager swarm that exhibit this failure. */
  affectedForagerIndexes: number[];
  /** Concise instruction for the specialist forager telling it what to fix. */
  specialistFocus: string;
  severity: "high" | "medium" | "low";
}

export type ModelSlot = Caste | "scribe" | "embedding";

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

/** The project manifest, stored at <root>/.flytown/terrarium.json. */
export interface TerrariumManifest {
  name: string;
  version: number;
  createdAt: string;
  defaultModelForager: string;
  defaultModelSoldier: string;
  defaultModelGuard: string;
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
