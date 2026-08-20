---
name: goal-planning
description: Spawn a planning subagent to create non-overlapping, fully-covering acceptance criteria before implementation.
---

For multi-step tasks, spawn a planning subagent before calling
`set_acceptance_criteria`. The subagent must:

1. Explore the relevant code, tests, and configuration.
2. Extract every requirement from the user's goal.
3. Draft concrete criteria with unique kebab-case IDs and explicit verification methods.
4. Build a goal-backward coverage matrix mapping every requirement to criteria.
5. Merge overlapping criteria and replace vague verbs with observable actions.
6. Submit the final criteria and atomic task plan.

Do not proceed to implementation while the coverage matrix contains an
UNCOVERED requirement. Criteria using commands must name the exact command
and expected result; file and URL criteria must name the exact check.
