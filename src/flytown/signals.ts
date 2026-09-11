/**
 * Task signals — the structured "sensory field" every planner backend sees.
 *
 * Everything here is an ENGINEERING_CHOICE: a deterministic featurisation of
 * the task text, the repository, prior attempts and caller-supplied facts.
 * No model calls. The same signals feed the rules baseline, the learned
 * baseline and the fly planner's sensory encoder, so backends differ only in
 * how they decide, never in what they can see.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, Plan } from "../types.js";

export type Deliverable = "answer" | "code_change" | "investigation" | "research" | "verification" | "unknown";
export const DELIVERABLES: Deliverable[] = ["answer", "code_change", "investigation", "research", "verification", "unknown"];

export interface RepoSignals {
  present: boolean;
  fileCount: number;
  /** extension -> count (top extensions only) */
  languages: Record<string, number>;
  hasTests: boolean;
  hasPackageManifest: boolean;
  frameworks: string[];
  truncated: boolean;
}

/** Facts the caller can supply that cannot be derived from text/repo. */
export interface ExternalSignals {
  testFailures: number;
  runtimeErrors: number;
  compileErrors: number;
  toolsAvailable: string[];
  approvalsPending: number;
  /** 0..1 — how much of the budget/time is already spent or how tight it is. */
  pressure: number;
  /** Prior attempts on this task known to the caller (outside the current plan). */
  priorAttempts: number;
  priorOutcome?: "success" | "failure";
  /** Reviewer verdicts so far: agreements vs contradictions between workers. */
  contradictions: number;
}

export interface TaskSignals {
  task: string;
  taskLength: number;
  deliverable: Deliverable;
  keywords: string[];
  /** 0..1 heuristic complexity from length, conjunctions, enumerations. */
  complexity: number;
  /** 0..1 heuristic from hedging words / questions / "not sure". */
  uncertainty: number;
  securitySensitive: boolean;
  constraints: string[];
  repo: RepoSignals;
  failures: { testFailures: number; runtimeErrors: number; compileErrors: number };
  pressure: number;
  conflictingHypotheses: number;
  history: {
    attempts: number;
    replanDepth: number;
    lastOutcome?: "success" | "failure";
    failureReason?: string;
    failedNodeAction?: string;
  };
  toolsAvailable: string[];
  approvalsPending: number;
  priorArtifacts: number;
  /** Explicit stop / blocked cues in the task text. */
  cues: { mentionsBlocked: boolean; asksToStop: boolean; asksForApproval: boolean; misleadingHint: boolean };
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target", "release", ".cache"]);
const TEST_HINTS = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$/;
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json"];
const FRAMEWORK_HINTS: [RegExp, string][] = [
  [/next\.config\.[cm]?[jt]s$/, "nextjs"],
  [/vite\.config\.[cm]?[jt]s$/, "vite"],
  [/tsconfig\.json$/, "typescript"],
  [/pnpm-workspace\.yaml$/, "pnpm-workspace"],
  [/Dockerfile$/, "docker"],
  [/hardhat\.config\.[cm]?[jt]s$/, "hardhat"],
  [/foundry\.toml$/, "foundry"],
  [/render\.yaml$/, "render"],
  [/vercel\.json$/, "vercel"],
  [/electron/, "electron"],
];

export async function scanRepo(cwd: string, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<RepoSignals> {
  const maxFiles = opts.maxFiles ?? 4000;
  const maxDepth = opts.maxDepth ?? 6;
  const out: RepoSignals = { present: false, fileCount: 0, languages: {}, hasTests: false, hasPackageManifest: false, frameworks: [], truncated: false };
  try {
    const s = await stat(cwd);
    if (!s.isDirectory()) return out;
  } catch {
    return out;
  }
  out.present = true;
  const frameworks = new Set<string>();
  const stack: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  while (stack.length > 0 && out.fileCount < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.fileCount >= maxFiles) { out.truncated = true; break; }
      const rel = join(dir, e.name).slice(cwd.length + 1);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < maxDepth) stack.push({ dir: join(dir, e.name), depth: depth + 1 });
        if (TEST_HINTS.test(rel + "/")) out.hasTests = true;
        continue;
      }
      out.fileCount++;
      const dot = e.name.lastIndexOf(".");
      if (dot > 0) {
        const ext = e.name.slice(dot + 1).toLowerCase();
        out.languages[ext] = (out.languages[ext] ?? 0) + 1;
      }
      if (TEST_HINTS.test(rel)) out.hasTests = true;
      if (depth === 0 && MANIFESTS.includes(e.name)) out.hasPackageManifest = true;
      for (const [re, name] of FRAMEWORK_HINTS) if (re.test(rel)) frameworks.add(name);
    }
  }
  // Keep the top 8 extensions only — the vector must stay small and stable.
  out.languages = Object.fromEntries(
    Object.entries(out.languages).sort((a, b) => b[1] - a[1]).slice(0, 8),
  );
  out.frameworks = [...frameworks].sort();
  return out;
}

const STOPWORDS = new Set("the a an and or of to in for on with by from at as is are be this that it its into your our their we you".split(" "));

export function extractTaskKeywords(task: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const raw of task.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    const w = raw.replace(/^[./-]+|[./-]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w);
}

export function classifyDeliverable(task: string): Deliverable {
  const t = task.toLowerCase();
  if (/\b(verify|check whether|confirm that|does .* (pass|work|build)|run (the )?tests?|smoke[- ]test|deploy(ment)? check)\b/.test(t)) return "verification";
  if (/\b(why|investigate|diagnose|debug|root cause|figure out|flak|intermittent|fails? (sometimes|randomly))\b/.test(t)) return "investigation";
  if (/\b(implement|add|fix|refactor|rename|migrate|write (a|the) (function|class|module|test)|change|update|remove|delete|create|build)\b/.test(t)) return "code_change";
  if (/\b(research|survey|compare|summari[sz]e|literature|options|trade-?offs|evaluate|assess|review the)\b/.test(t)) return "research";
  if (/\b(what|where|which|how (does|do|is)|explain|describe|list)\b/.test(t) || t.trim().endsWith("?")) return "answer";
  return "unknown";
}

export function estimateComplexity(task: string): number {
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  const conj = (task.match(/\b(and|then|also|plus|as well as|after that|additionally)\b/gi) ?? []).length;
  const enumerations = (task.match(/(^|\n)\s*([-*•]|\d+[.)])\s+/g) ?? []).length;
  const files = (task.match(/[\w/-]+\.(ts|js|tsx|jsx|py|rs|go|sol|md|json|yaml|yml|toml)\b/g) ?? []).length;
  const score = Math.min(1, words / 120) * 0.45 + Math.min(1, conj / 4) * 0.25 + Math.min(1, enumerations / 5) * 0.2 + Math.min(1, files / 4) * 0.1;
  return clamp01(score);
}

export function estimateUncertainty(task: string): number {
  const t = task.toLowerCase();
  const hedges = (t.match(/\b(maybe|might|not sure|unclear|possibly|i think|seems|perhaps|unknown|somehow|sometimes|intermittent|flaky|can'?t tell|no idea)\b/g) ?? []).length;
  const questions = (t.match(/\?/g) ?? []).length;
  const alternatives = (t.match(/\b(either|or maybe|one of|could be|alternatively)\b/g) ?? []).length;
  return clamp01(Math.min(1, hedges / 3) * 0.5 + Math.min(1, questions / 3) * 0.25 + Math.min(1, alternatives / 2) * 0.25);
}

export function detectSecuritySensitivity(task: string): boolean {
  return /\b(auth|passwords?|secrets?|tokens?|credentials?|api[- ]?keys?|permissions?|sandbox|inject(ion)?|xss|csrf|sql|encrypt(ion)?|private keys?|wallets?|signing|escalat\w*|vulnerab\w*|cve|exploits?)\b/i.test(task);
}

export function extractConstraints(task: string): string[] {
  const out: string[] = [];
  for (const m of task.matchAll(/\b(must|must not|do not|don'?t|never|only|without|no more than|at most|under \d+|before [A-Z]?\w+day)\b[^.\n]*/gi)) {
    out.push(m[0].trim().slice(0, 80));
    if (out.length >= 6) break;
  }
  return out;
}

export function countConflictingHypotheses(task: string, failureReason?: string): number {
  const text = `${task}\n${failureReason ?? ""}`.toLowerCase();
  const explicit = (text.match(/\b(hypothes[ie]s|theor(y|ies)|possible cause|could be (a|the|that)|or it could)\b/g) ?? []).length;
  const alternatives = (text.match(/\b(either|otherwise|or else|versus|vs\.?)\b/g) ?? []).length;
  return Math.min(6, explicit + alternatives);
}

export function detectCues(task: string) {
  const t = task.toLowerCase();
  return {
    mentionsBlocked: /\b(blocked|cannot proceed|no access|missing (credentials|permission|access)|requires? (a )?human|waiting on)\b/.test(t),
    asksToStop: /\b(stop (early|if)|don'?t (continue|proceed) if|only if trivial|abort if|give up if|bail (out )?if)\b/.test(t),
    asksForApproval: /\b(ask (me|for) (approval|permission|before)|confirm with me|get sign-?off|require(s)? approval|check with (me|a human))\b/.test(t),
    misleadingHint: /\b(probably|likely|i suspect|i bet|it'?s clearly|obviously the)\b/.test(t),
  };
}

export interface DeriveSignalsInput {
  task: string;
  cwd: string;
  parentArtifacts?: Artifact[];
  failureContext?: { failedNodeId: string; reason: string; partialPlan: Plan };
  replanDepth?: number;
  budgetTokens?: number;
  extra?: Partial<ExternalSignals>;
  /** Pre-computed repo scan (cache across replans / eval runs). */
  repo?: RepoSignals;
}

export async function deriveSignals(input: DeriveSignalsInput): Promise<TaskSignals> {
  const repo = input.repo ?? (await scanRepo(input.cwd));
  const extra = input.extra ?? {};
  const failedNode = input.failureContext
    ? input.failureContext.partialPlan.nodes.find((n) => n.id === input.failureContext!.failedNodeId)
    : undefined;
  const attempts = (extra.priorAttempts ?? 0) + (input.replanDepth ?? 0);
  const budgetPressure = input.budgetTokens !== undefined ? clamp01(1 - Math.min(1, input.budgetTokens / 60_000)) : 0;
  return {
    task: input.task,
    taskLength: input.task.length,
    deliverable: classifyDeliverable(input.task),
    keywords: extractTaskKeywords(input.task),
    complexity: estimateComplexity(input.task),
    uncertainty: estimateUncertainty(input.task),
    securitySensitive: detectSecuritySensitivity(input.task),
    constraints: extractConstraints(input.task),
    repo,
    failures: {
      testFailures: extra.testFailures ?? 0,
      runtimeErrors: extra.runtimeErrors ?? 0,
      compileErrors: extra.compileErrors ?? 0,
    },
    pressure: clamp01(Math.max(extra.pressure ?? 0, budgetPressure)),
    conflictingHypotheses: Math.max(extra.contradictions ?? 0, countConflictingHypotheses(input.task, input.failureContext?.reason)),
    history: {
      attempts,
      replanDepth: input.replanDepth ?? 0,
      lastOutcome: input.failureContext ? "failure" : extra.priorOutcome,
      failureReason: input.failureContext?.reason,
      failedNodeAction: failedNode?.hints?.action,
    },
    toolsAvailable: extra.toolsAvailable ?? [],
    approvalsPending: extra.approvalsPending ?? 0,
    priorArtifacts: input.parentArtifacts?.length ?? 0,
    cues: detectCues(input.task),
  };
}

/**
 * Fixed-order numeric feature vector derived from TaskSignals. Used by the
 * learned baseline and the fly sensory encoder. Order is part of the trace
 * contract — append, never reorder.
 */
export const FEATURE_NAMES = [
  "complexity", "uncertainty", "repo_size", "repo_has_tests", "repo_has_manifest",
  "test_failures", "runtime_errors", "compile_errors", "security_sensitive", "pressure",
  "prior_success", "prior_failure", "attempts", "conflicting", "approvals_pending",
  "prior_artifacts", "constraints", "cue_blocked", "cue_stop", "cue_approval", "cue_misleading",
  "deliv_answer", "deliv_code_change", "deliv_investigation", "deliv_research", "deliv_verification", "deliv_unknown",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export function featurize(s: TaskSignals): Float64Array {
  const f = new Float64Array(FEATURE_NAMES.length);
  const set = (name: FeatureName, v: number) => { f[FEATURE_NAMES.indexOf(name)] = clamp01(v); };
  set("complexity", s.complexity);
  set("uncertainty", s.uncertainty);
  set("repo_size", s.repo.present ? Math.log10(1 + s.repo.fileCount) / 4 : 0);
  set("repo_has_tests", s.repo.hasTests ? 1 : 0);
  set("repo_has_manifest", s.repo.hasPackageManifest ? 1 : 0);
  set("test_failures", Math.min(1, s.failures.testFailures / 5));
  set("runtime_errors", Math.min(1, s.failures.runtimeErrors / 3));
  set("compile_errors", Math.min(1, s.failures.compileErrors / 5));
  set("security_sensitive", s.securitySensitive ? 1 : 0);
  set("pressure", s.pressure);
  set("prior_success", s.history.lastOutcome === "success" ? 1 : 0);
  set("prior_failure", s.history.lastOutcome === "failure" ? 1 : 0);
  set("attempts", Math.min(1, s.history.attempts / 3));
  set("conflicting", Math.min(1, s.conflictingHypotheses / 4));
  set("approvals_pending", Math.min(1, s.approvalsPending / 2));
  set("prior_artifacts", Math.min(1, s.priorArtifacts / 3));
  set("constraints", Math.min(1, s.constraints.length / 4));
  set("cue_blocked", s.cues.mentionsBlocked ? 1 : 0);
  set("cue_stop", s.cues.asksToStop ? 1 : 0);
  set("cue_approval", s.cues.asksForApproval ? 1 : 0);
  set("cue_misleading", s.cues.misleadingHint ? 1 : 0);
  for (const d of DELIVERABLES) set(`deliv_${d}` as FeatureName, s.deliverable === d ? 1 : 0);
  return f;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
