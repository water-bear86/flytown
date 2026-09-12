# Research Foundations

FLYTOWN's worker pipeline is built around a small set of pragmatic
multi-agent bets:

- diverse first drafts are useful only when review is stricter than generation;
- a context step should reduce noise, not spray every file into every prompt;
- critique is more useful when it happens before final selection;
- recovery should target the failure mode, not restart from a blank prompt;
- memory has to be structured enough to reuse later.

The caste names describe the jobs. The contracts are what the code enforces.

The pipeline deliberately stays in the prompted, training-free slice of the
multi-agent literature, so it runs with nothing more than an
OpenAI-compatible API key. The connectome-derived planners have their own
foundations, assumptions and falsification protocol: see
[PROPOSAL.md](../../PROPOSAL.md) and the
[experiment log](../flytown/experiments/README.md).

## Decomposition

The planner turns broad work into a DAG of narrower flights. The executor
passes parent Artifacts into dependent nodes and caps replanning after
failures. The plan-then-execute split comes from Parmar, *MCP Workflow
Engine: Separating Intelligence from Execution* (arXiv:2605.00827, 2026);
dynamic topology selection and recursive-self-as-worker are borrowed as
prompted heuristics from Nielsen et al., *Learning to Orchestrate Agents in
Natural Language with the Conductor* (arXiv:2512.04388, 2025).

## Diversity

The swarm varies prompts and personality labels. This is not because
personality is magic; it is because candidate diversity gives the reviewer
something to compare. The optional debate round is inspired by the
training-free result in Zou et al., *Latent Collaboration in Multi-Agent
Systems* (arXiv:2511.20639, 2025).

## Adversarial Review

Wasp critique and guard review are separate stages. The wasp creates failure
pressure. The guard decides whether a candidate is acceptable and may call
verifier tools before scoring — the verifier-as-reward pattern from Peng et
al., *CriticLean: Critic-Guided Reinforcement Learning for Mathematical
Formalization* (arXiv:2507.06181, 2025).

## Recovery

When the whole swarm fails, the flight clusters the failures and asks
specialist foragers to repair the best seed. This keeps useful work instead of
discarding everything because the first pass missed one important constraint.
Spawning a minimal specialist that targets the dominant error follows Saeidi
et al., *FAMA: Failure-Aware Meta-Agentic Framework* (arXiv:2604.25135, 2026).

## Durable Memory

Artifacts written by the messenger in Scribe mode are the memory boundary.
Raw transcripts are too much; single-line summaries are too little. Artifacts
preserve claims, evidence, open questions, next steps, keywords, and parent
links — an adaptation of the "epistemic bookkeeping" in Zhou & Chan, *ADEMA:
Knowledge-State Orchestration for Long-Horizon Synthesis* (arXiv:2604.25849,
2026).

## Traces

`flytown export-trace` writes the JSON trace schema from xxzcc, *Awesome LLM-MAS
RL* (<https://github.com/xxzcc/awesome-llm-mas-rl>, 2026), whose five
orchestration sub-decisions — spawn, delegate, communicate, aggregate, stop —
also motivated the debate round.
