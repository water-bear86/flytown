/**
 * Export a FLYTOWN flight as an LLM-MAS Orchestration Trace
 * (https://github.com/xxzcc/awesome-llm-mas-rl/blob/main/trace-schema/trace_schema.json).
 *
 * Maps FLYTOWN SSE step events onto the academic schema's 10 event types:
 *   orchestrator_decision, spawn, despawn, message, tool_call, tool_result,
 *   return, aggregate, human_intervention, safety_event
 *
 * And the 8 edge types:
 *   temporal, causal, spawn, message, tool_dependency, return, aggregate,
 *   safety_flow
 */
import type { RunRecord } from "./run-store.js";
import type { FlightStep } from "./flight.js";

export type MasEventType =
  | "orchestrator_decision"
  | "spawn"
  | "despawn"
  | "message"
  | "tool_call"
  | "tool_result"
  | "return"
  | "aggregate"
  | "human_intervention"
  | "safety_event";

export type MasEdgeType =
  | "temporal"
  | "causal"
  | "spawn"
  | "message"
  | "tool_dependency"
  | "return"
  | "aggregate"
  | "safety_flow";

export interface MasEvent {
  id: string;
  t: number;
  type: MasEventType;
  agent: string;
  role?: string;
  from?: string;
  to?: string;
  tool?: string;
  content_ref?: string;
  trusted?: boolean;
  [extra: string]: unknown;
}

export interface MasEdge {
  src: string;
  dst: string;
  type: MasEdgeType;
}

export interface MasTrace {
  trace_id: string;
  task_id: string;
  system?: string;
  topology:
    | "centralized"
    | "planner_executor_critic"
    | "debate"
    | "swarm"
    | "hierarchical"
    | "harness"
    | "mixed"
    | "unknown";
  events: MasEvent[];
  edges: MasEdge[];
  rewards: Record<string, number>;
  costs: { tokens: number; wall_clock_s: number; tool_calls?: number; messages?: number };
  metrics?: Record<string, number>;
}

/**
 * Convert a FLYTOWN RunRecord into the academic LLM-MAS trace schema.
 * Pure function: deterministic given the same input.
 */
export function exportRunAsMasTrace(run: RunRecord, system = "flytown"): MasTrace {
  const events: MasEvent[] = [];
  const edges: MasEdge[] = [];
  const foragerIdByIndex = new Map<number, string>();
  const foragerAgentByMorselId = new Map<string, string>();
  const specialistAgentByIndex = new Map<number, string>();
  let totalTokens = 0;
  let prevEventId: string | null = null;
  let scoutEventId: string | null = null;
  let guardEventId: string | null = null;
  let lastClusterEventId: string | null = null;

  // Initial orchestrator_decision: starting the flight.
  pushEvent({
    id: "ev-0000",
    t: 0,
    type: "orchestrator_decision",
    agent: "orchestrator",
    role: "flight-controller",
    decision: "start_flight",
    task: run.task,
    swarm_size: run.swarmSize,
  });

  let n = 1;
  const startedAt = run.startedAt;
  const evId = (): string => `ev-${String(n++).padStart(4, "0")}`;
  const tOf = (): number => {
    // events are stored in order but without timestamps; approximate with sequence offset.
    return Math.max(0, n - 1);
  };

  function pushEvent(ev: MasEvent): void {
    events.push(ev);
    if (prevEventId) edges.push({ src: prevEventId, dst: ev.id, type: "temporal" });
    prevEventId = ev.id;
  }

  function pushCausal(srcId: string, dstId: string, type: MasEdgeType = "causal"): void {
    edges.push({ src: srcId, dst: dstId, type });
  }

  for (const wrap of run.events ?? []) {
    // Plan-level events come through as their own kind, not as "step".
    if (wrap.kind === "plan:planning") {
      const id = evId();
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "begin_planning",
      });
      continue;
    }
    if (wrap.kind === "plan:built") {
      const id = evId();
      const data = wrap.data as { plan?: { nodes?: unknown[] } };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "plan_built",
        node_count: data.plan?.nodes?.length ?? 0,
      });
      continue;
    }
    if (wrap.kind === "plan:node:start") {
      const id = evId();
      const data = wrap.data as { nodeId?: string };
      pushEvent({
        id, t: tOf(), type: "spawn", agent: `node:${data.nodeId ?? "?"}`,
        role: "flight",
      });
      continue;
    }
    if (wrap.kind === "plan:node:done") {
      const id = evId();
      const data = wrap.data as { nodeId?: string; outcome?: string; flightId?: string; artifactId?: string };
      pushEvent({
        id, t: tOf(), type: "return", agent: `node:${data.nodeId ?? "?"}`,
        outcome: data.outcome,
        flight_id: data.flightId,
        content_ref: data.artifactId,
      });
      continue;
    }
    if (wrap.kind === "plan:node:failed") {
      const id = evId();
      const data = wrap.data as { nodeId?: string; reason?: string };
      pushEvent({
        id, t: tOf(), type: "safety_event", agent: `node:${data.nodeId ?? "?"}`,
        severity: "warning", message: data.reason,
      });
      continue;
    }
    if (wrap.kind === "plan:replan") {
      const id = evId();
      const data = wrap.data as { depth?: number; reason?: string };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "replan", depth: data.depth, reason: data.reason,
      });
      continue;
    }
    if (wrap.kind === "plan:done") {
      const id = evId();
      const data = wrap.data as { outcome?: string };
      pushEvent({
        id, t: tOf(), type: "orchestrator_decision", agent: "planner",
        decision: "stop_plan", outcome: data.outcome,
      });
      continue;
    }
    if (wrap.kind !== "step") continue;
    // Plan-mode runs wrap each flight step as { nodeId, step }; unwrap.
    const raw = wrap.data as FlightStep | { nodeId: string; step: FlightStep };
    const step = (raw as { step?: FlightStep }).step
      ? (raw as { nodeId: string; step: FlightStep }).step
      : (raw as FlightStep);
    switch (step.kind) {
      case "scout:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "scout", role: "context-gatherer",
          globs: step.globs,
        });
        scoutEventId = id;
        edges.push({ src: "ev-0000", dst: id, type: "spawn" });
        break;
      }
      case "scout:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "scout",
          content_ref: step.morselId, file_count: step.fileCount,
        });
        if (scoutEventId) pushCausal(scoutEventId, id, "return");
        break;
      }
      case "artifacts:loaded": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "message", agent: "orchestrator", to: "scout",
          message_kind: "memory_load",
          artifact_ids: step.artifactIds,
        });
        break;
      }
      case "swarm:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "dispatch_swarm", swarm_size: step.size,
        });
        for (let i = 0; i < step.size; i++) {
          const sid = evId();
          const agent = `forager#${i}`;
          foragerIdByIndex.set(i, sid);
          pushEvent({
            id: sid, t: tOf(), type: "spawn", agent, role: "worker",
            parent_decision: id,
          });
          edges.push({ src: id, dst: sid, type: "spawn" });
        }
        break;
      }
      case "swarm:forager": {
        const id = evId();
        const agent = `forager#${step.index}`;
        foragerAgentByMorselId.set(step.morselId, agent);
        pushEvent({
          id, t: tOf(), type: "return", agent,
          content_ref: step.morselId, personality: step.personality,
        });
        const spawnId = foragerIdByIndex.get(step.index);
        if (spawnId) pushCausal(spawnId, id, "return");
        break;
      }
      case "sting:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "wasp", role: "adversary",
        });
        break;
      }
      case "sting:done": {
        const id = evId();
        const targetAgent = foragerAgentByMorselId.get(step.foragerId) ?? "forager#?";
        pushEvent({
          id, t: tOf(), type: "message", agent: "wasp",
          to: targetAgent, message_kind: "attack",
          content_ref: step.waspId,
        });
        break;
      }
      case "review:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "guard", role: "critic",
        });
        guardEventId = id;
        break;
      }
      case "review:verdict": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "aggregate", agent: "guard",
          content_ref: step.verdict.morselId,
          passed: step.verdict.passed,
          score: step.verdict.score,
        });
        if (guardEventId) pushCausal(guardEventId, id, "aggregate");
        const foragerAgent = foragerAgentByMorselId.get(step.verdict.morselId);
        if (foragerAgent) {
          edges.push({ src: foragerAgent, dst: id, type: "aggregate" });
        }
        break;
      }
      case "specialist:cluster:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "cluster_failures",
        });
        lastClusterEventId = id;
        break;
      }
      case "specialist:cluster:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "tool_result", agent: "orchestrator",
          tool: "failure_clustering", clusters: step.clusters,
        });
        if (lastClusterEventId) pushCausal(lastClusterEventId, id, "tool_dependency");
        break;
      }
      case "specialist:spawn": {
        const id = evId();
        const agent = `specialist#${step.index}`;
        specialistAgentByIndex.set(step.index, agent);
        pushEvent({
          id, t: tOf(), type: "spawn", agent, role: "specialist-worker",
          focus: step.focus,
        });
        break;
      }
      case "specialist:done": {
        const id = evId();
        const agent = specialistAgentByIndex.get(step.index) ?? `specialist#${step.index}`;
        pushEvent({
          id, t: tOf(), type: "return", agent,
          content_ref: step.morselId,
        });
        break;
      }
      case "specialist:verdict": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "aggregate", agent: "guard",
          content_ref: step.verdict.morselId,
          passed: step.verdict.passed,
          score: step.verdict.score,
          phase: "specialist_review",
        });
        break;
      }
      case "fallback:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "soldier", role: "heavyweight-fallback",
        });
        break;
      }
      case "fallback:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "soldier",
          content_ref: step.morselId,
        });
        break;
      }
      case "scribe:start": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "spawn", agent: "messenger-scribe", role: "memory-distiller",
        });
        break;
      }
      case "scribe:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "return", agent: "messenger-scribe",
          content_ref: step.artifactId,
        });
        break;
      }
      case "scribe:error": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "safety_event", agent: "messenger-scribe",
          severity: "warning", message: step.message,
        });
        break;
      }
      case "thinking": {
        // Streaming intermediate output — ignored for trace export to keep it compact.
        // (The schema treats per-token deltas as below the trace abstraction.)
        break;
      }
      case "budget:exceeded": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "safety_event", agent: "orchestrator",
          severity: "warning", phase: step.phase, used: step.used, cap: step.cap,
        });
        break;
      }
      case "flight:done": {
        const id = evId();
        pushEvent({
          id, t: tOf(), type: "orchestrator_decision", agent: "orchestrator",
          decision: "stop_flight", outcome: step.outcome,
        });
        break;
      }
    }
  }

  const wallClockS = run.finishedAt
    ? Math.max(0, (run.finishedAt - startedAt) / 1000)
    : 0;

  // Map outcome to a topology classification: flights with a planner subtree
  // count as planner_executor_critic; specialist recovery alone = mixed;
  // baseline = centralized.
  const hasPlanner = events.some(
    (e) => e.agent === "planner" || (typeof e.agent === "string" && e.agent.startsWith("node:")),
  );
  const hasSpecialist = events.some(
    (e) => typeof e.agent === "string" && e.agent.startsWith("specialist#"),
  );
  const topology: MasTrace["topology"] = hasPlanner
    ? "planner_executor_critic"
    : hasSpecialist
      ? "mixed"
      : "centralized";

  return {
    trace_id: run.runId,
    task_id: run.finalFlightId ?? run.runId,
    system,
    topology,
    events,
    edges,
    rewards: {},
    costs: {
      tokens: totalTokens,
      wall_clock_s: wallClockS,
      messages: events.filter((e) => e.type === "message").length,
    },
    metrics: {
      swarm_size: run.swarmSize,
    },
  };
}
