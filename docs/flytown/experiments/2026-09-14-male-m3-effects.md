# Action-effect audit — male and female region-level planners (M3)

Decide only, no workers, no model calls; suite public-v2 at its pinned commits; seed 1. Reproduce: `flytown fly effects --planners "fly:connectome=malecns-v1.0-projectome-1,fly:connectome=malecns-v1.0-projectome-1+shuffled,fly,fly:shuffled"`

```text
action-effect audit over 20 fixtures (decide only, no workers, no model calls)
primary: shaped / default / inert · shaped = changed the plan · default = the plan has it anyway · inert = ignored by the compiler

planner                                                   primary s/d/i  selected  shaped  =default  =rules  halts  top-margin
fly:connectome=malecns-v1.0-projectome-1                         5/15/0      3.85    1.95         0       2      2       0.033
fly:connectome=malecns-v1.0-projectome-1+shuffled                11/9/0      3.60    1.45         0       2      2       0.054
fly                                                              18/2/0      3.50    1.35         0       3      3       0.025
fly:shuffled                                                     19/1/0      3.10    1.75         0       3      2       0.080

primary actions:
  fly:connectome=malecns-v1.0-projectome-1: request_artifact_investigation×11 run_tool×4 search_memory×3 terminate_blocked×2
  fly:connectome=malecns-v1.0-projectome-1+shuffled: merge_results×7 run_tool×4 surface_uncertainty×3 request_artifact_investigation×2 search_memory×2 terminate_blocked×2
  fly: search_memory×15 request_artifact_investigation×2 terminate_blocked×2 request_human_approval×1
  fly:shuffled: request_artifact_investigation×9 surface_uncertainty×5 run_tool×4 terminate_blocked×2
```
