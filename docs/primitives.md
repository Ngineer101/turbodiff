# Primitives

Turbodiff is a software factory built from a small set of primitives: agents, artifacts, skills, integrations, automations, and factory flows.

## Agents

An agent is the generic unit of AI work. It:

- uses a model and prompt;
- receives an input artifact;
- may interact with a repository and integrations;
- produces an output artifact.

All agents run through the same interface:

```ts
runAgent(agent, input, context): Promise<Artifact>
```

Turbodiff has named agent specifications such as `planner`, `implementer`, `reviewer`, `fixer`, `verifier`, and `explainer`. These are not separate execution systems. They are lightweight definitions of the same primitive with different prompts, inputs, outputs, and repository access. The model is selected per invocation, so the same definition can run with different models without becoming a new agent runtime.

An agent definition must not know about queues, databases, Workflows, GitHub, or publication. The executor provides the model, repository, skills, and integrations. Orchestration persists the artifact and owns every side effect and decision about what runs next.

For example, a reviewer reads a normalized change and produces a review artifact. GitHub is only one integration that can supply the change and publish that artifact.

## Artifacts

An artifact is the typed output of an agent and can be used as the input to another agent.

Examples include:

- a plan;
- a code change or commit;
- a pull request;
- review findings;
- a verification report;
- an explanation.

Artifacts form the contracts between agents. Agents produce artifacts but do not decide what should run next.

## Skills

A skill is a reusable set of instructions or knowledge that can be made available to an agent when it runs.

Skills may be configured for a repository, an agent, or an individual automation. The same skill-resolution rules should apply to every agent.

Skills provide knowledge; they do not grant access to external systems.

## Integrations

An integration connects Turbodiff to an external system that an agent can use for context or actions.

Examples include GitHub, Cloudflare Artifacts, and MCP servers. Credentials and permissions remain outside the agent and are provided only for the duration of a run.

## Automations

An automation is an agent invocation with a schedule:

```text
schedule + agent + input
```

Automations use the same agents, skills, integrations, and artifacts as manually started work. They are not a separate AI execution system.

## Factory flows

A factory flow runs agents in sequence, passing each agent's artifact to the next:

```text
Planner → Plan → Implementer → Change → Reviewer → Review → Fixer → Change → Verifier
```

An orchestrator controls this sequence. It decides which agent runs next, whether a step should be retried, and where human input or approval is required. Agents only perform their assigned work and return an artifact.

## Planned direction

The architecture should move toward:

1. one generic `runAgent` execution interface;
2. explicit, lightweight definitions for each named agent;
3. typed artifacts as the only contracts between agents;
4. consistent skill and integration resolution for every run;
5. automations that invoke normal agents on a schedule;
6. one orchestrator that controls factory flows and human gates.

Flue, OpenCode, Sandbox, Queues, and Cloudflare Workflows are implementation details behind these abstractions, not separate product primitives.
