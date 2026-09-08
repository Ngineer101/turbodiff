---
name: "high-value-tests"
description: "Design, implement, and critically review automated tests that catch meaningful product regressions."
---

---
name: write-high-value-tests
description: Design, implement, and critically review automated tests that catch meaningful product regressions. Use for test strategies, new feature tests, regression tests, integration and end-to-end coverage, flaky or low-value suite cleanup, PR test reviews, coverage-gap analysis, and requests to improve testing without adding superficial UI assertions or coverage theater.
---

# Write High-Value Tests

Optimize for failures caught per unit of maintenance, not test count or coverage percentage.

## Start With Risk

Map the behavior before writing tests:

1. Identify the user or business outcome.
2. Trace inputs through trust boundaries, state changes, asynchronous handoffs, and external effects.
3. Rank failures by impact and likelihood.
4. Locate existing tests so new cases do not duplicate an invariant already proved at a better layer.
5. Select the cheapest test level that can observe the real contract.

Prioritize authorization, tenant isolation, money or quota consumption, destructive actions, autonomous writes, state transitions, retries, concurrency, idempotency, serialization, queue payloads, database constraints, and third-party response handling.

## Require a Regression Hypothesis

Before adding a test, complete this sentence:

> This test fails if ___ breaks, and that matters because ___.

Do not add the test if the blank can only be filled with an implementation detail that users and downstream components cannot observe.

Apply a mutation check after implementation. Imagine or temporarily make a plausible defect:

- remove the core side effect;
- change an identifier, permission, queue field, or state transition;
- swap head and tail truncation;
- remove a bound or retry guard;
- deliver the same event twice;
- make one dependency fail;
- cross a tenant or ownership boundary.

If the test still passes, strengthen it or delete it.

## Choose the Right Fidelity

Use real code for the behavior under test and fake only true boundaries.

- Use pure unit tests for transformations, parsing, policy tables, and boundary arithmetic.
- Use the real router, middleware, runtime, database schema, and queries for authorization and persistence behavior.
- Use contract tests at queues, workflows, HTTP clients, storage bindings, and serialization boundaries. Assert the exact payload or durable effect.
- Use end-to-end tests only for a small number of critical journeys that cannot be proved below the UI.

Avoid mocking the function whose behavior the test claims to prove. Inject narrow boundary dependencies such as `sendMessage`, `clock`, `fetch`, or `executeJob`, while keeping production defaults unchanged.

## Assert Outcomes, Not Self-Reports

Prefer durable or externally visible evidence:

- database rows and constraints;
- exact queue or workflow messages;
- authorization decisions and absence of mutation;
- emitted API requests;
- final state after retries or duplicate delivery;
- bounded output and graceful partial failure.

A handler returning `{ enqueued: true }` does not prove a message was sent. A mock being called does not prove state changed. A status code alone rarely proves tenant isolation. Assert the consequential effect and important non-effects.

At asynchronous boundaries, test both sides of the contract:

1. The producer emits the exact message schema.
2. The consumer accepts that schema and forwards every required field.
3. The consumer revalidates stale authorization and state before irreversible or costly work.
4. Duplicate and concurrent delivery remain safe.

## Cover Failure Shape, Not Every Branch

Do not mirror every `if` statement. Choose cases with distinct risk:

- one qualifying happy path that proves the complete effect;
- one authorization or ownership denial that proves no effect occurred;
- one lifecycle case where state changes between intake and execution;
- one duplicate or concurrent case for paid or destructive work;
- one boundary case at each explicit limit;
- one partial dependency failure when the design promises degradation;
- one malformed external response when parsing is non-trivial.

Use boundary-sized fixtures. A ten-character string cannot prove an 8,000-character tail limit. One item cannot prove a five-item cap. One successful dependency cannot prove partial-failure behavior.

## Treat UI Tests as a Last Mile

Keep UI tests only when they prove a valuable user journey or browser-specific integration, such as authentication redirects, form submission, accessibility-critical interaction, or a multi-step workflow.

Reject tests that merely:

- snapshot static markup;
- assert text already present as a source literal;
- check that a component renders without proving behavior;
- duplicate API or domain tests through a slower browser;
- depend on pixel details with no product invariant.

## Make Tests Trustworthy

- Isolate state per test and clean persistent fixtures deterministically.
- Never point tests at production resources or credentials.
- Restore fake timers, globals, environment changes, and network stubs after each test.
- Make time, randomness, and external responses explicit.
- Avoid order dependence and shared mutable fixtures.
- Assert that denied operations leave no rows, messages, files, or remote calls behind.
- Keep fixtures small but realistic; hide setup in helpers only when the scenario remains readable.
- Prefer one strong scenario over several assertions that restate implementation branches.

## Review a Test Suite Critically

For each test, ask:

1. What realistic defect makes it fail?
2. Is that defect important?
3. Does the assertion observe the actual contract?
4. Could production be broken while this test stays green?
5. Is the test at the lowest layer that preserves confidence?
6. Does another test already prove the same invariant?
7. Will ordinary refactoring break it without changing behavior?

Classify findings by risk, not aesthetics. Lead with missing safety contracts and false-positive tests. Separate meaningful-but-incomplete tests from tests that add no value.

## Definition of Done

Before handing off test changes:

- State the regression hypothesis for each added scenario.
- Run focused tests, then the full relevant suite.
- Run typecheck, lint, formatting, and build checks appropriate to the repository.
- Confirm test data isolation and cleanup.
- Confirm plausible mutations would fail the new tests.
- Report what remains intentionally untested and why.

Do not claim comprehensive coverage from green CI alone. Report the behavior and failure modes now protected.
