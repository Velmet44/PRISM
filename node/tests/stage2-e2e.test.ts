/**
 * Stage 2 exit E2E (PRISM V1 §27.5, §58.2/§58.6/§58.9).
 *
 * Deterministic MOCK model only (injected into CognitionLoop; fixed step
 * script, no network/timers/randomness in assertions). Real node:sqlite via
 * the existing storage layer (applyPragmas + withTransaction-backed
 * managers) on :memory: handles plus the real EventBus. Full lifecycle per
 * test: AgentManager.create (Main only) -> Task PENDING->RUNNABLE->RUNNING ->
 * Run QUEUED->ADMITTED->RUNNING, steps to a committed checkpoint where the
 * case needs one.
 *
 * No Ollama, no HF, no wall-clock expiry dependence (injected clocks), no
 * temp files (in-memory DBs closed per test), generous 30s timeouts.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AgentManager } from "../src/agents/index.js";
import { TaskManager } from "../src/tasks/index.js";
import { RunManager } from "../src/runs/index.js";
import { BasicScheduler } from "../src/scheduler/index.js";
import { EventBus } from "../src/events/index.js";
import type { EphemeralMessage } from "../src/events/index.js";
import {
  CognitionLoop,
  createContext,
} from "../src/orchestration/index.js";
import { applyPragmas } from "../src/storage/index.js";
import type { EventEnvelope, SubscriptionFilter } from "@prism/schemas";

function runFilter(runId: string): SubscriptionFilter {
  return { run_id: runId } as unknown as SubscriptionFilter;
}

const NODE_ID = "node-stage2-e2e";
const OWNER_ID = "owner-stage2-e2e";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const ACTION_HASH = "d".repeat(64);
const ACTION_HASH_2 = "e".repeat(64);

const MOCK_SCRIPT = [
  "mock-plan: step-alpha",
  "mock-plan: step-beta",
  "mock-plan: done",
] as const;

interface Harness {
  db: DatabaseSync;
  now: () => number;
  nowSec: () => number;
  agents: AgentManager;
  tasks: TaskManager;
  runs: RunManager;
  events: EventBus;
  scheduler: BasicScheduler;
  loop: CognitionLoop;
  mockCalls: () => number;
  close: () => void;
}

function newHarness(): Harness {
  const db = new DatabaseSync(":memory:");
  applyPragmas(db);
  let tick = 1_700_000_000_000;
  const now = (): number => {
    tick += 1;
    return tick;
  };
  const nowSec = (): number => Math.floor(tick / 1000);
  const agents = new AgentManager({ db, now });
  const tasks = new TaskManager({ db, now });
  const runs = new RunManager({ db, now });
  const events = new EventBus(db, { nodeId: NODE_ID, nowSec });
  const scheduler = new BasicScheduler({ now });
  let calls = 0;
  const loop = new CognitionLoop({
    invokeModel: () => {
      const text: string = MOCK_SCRIPT[calls % MOCK_SCRIPT.length] as string;
      calls += 1;
      return { text };
    },
    summarize: (texts: string[]) => `summary:${texts.join("|")}`,
    now,
    maxContextItems: 64,
  });
  return {
    db,
    now,
    nowSec,
    agents,
    tasks,
    runs,
    events,
    scheduler,
    loop,
    mockCalls: () => calls,
    close: () => {
      try {
        db.close();
      } catch {
        // already closed; ignore for idempotent cleanup
      }
    },
  };
}

function codeOf(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return "";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Full lifecycle to RUNNING, driven once through the deterministic mock
 * model to prove the CognitionLoop injection. Returns the created records.
 */
async function bootToRunning(
  h: Harness,
  title = "e2e task",
): Promise<{ agentId: string; taskId: string; runId: string }> {
  const ctx = createContext([], h.now);
  const first = await h.loop.step(ctx, {
    agentDefinition: "e2e main agent",
    ownerInstructions: "do work",
  });
  expect(first.modelOutput.text).toBe(MOCK_SCRIPT[0]);
  expect(h.mockCalls()).toBe(1);

  const agent = h.agents.create({ name: "main-e2e" });
  expect(agent.isMain).toBe(true);
  expect(agent.state).toBe("READY");
  // Stage 2 admits Main only.
  try {
    h.agents.create({ name: "spec", kind: "specialist" });
    expect.unreachable("specialist creation must reject");
  } catch (err: unknown) {
    expect(codeOf(err)).toBe("UNSUPPORTED");
  }

  let task = h.tasks.create(agent.id, { title });
  expect(task.state).toBe("PENDING");
  task = h.tasks.makeRunnable(task.id);
  expect(task.state).toBe("RUNNABLE");
  task = h.tasks.start(task.id);
  expect(task.state).toBe("RUNNING");

  let run = h.runs.createRun({ taskId: task.id, agentId: agent.id });
  expect(run.state).toBe("QUEUED");
  expect(run.attemptNo).toBe(1);
  h.tasks.setActiveRun(task.id, run.id);

  const queued = h.scheduler.enqueue(run.id);
  expect(queued.runId).toBe(run.id);
  const admission = h.scheduler.admit();
  expect(admission?.runId).toBe(run.id);

  run = h.runs.admit(run.id);
  expect(run.state).toBe("ADMITTED");
  run = h.runs.beginRunning(run.id);
  expect(run.state).toBe("RUNNING");

  return { agentId: agent.id, taskId: task.id, runId: run.id };
}

describe("Stage 2 exit E2E", () => {
  it(
    "(1) live event observation: ordered, deduped, ephemeral never replayed",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { agentId, taskId, runId } = await bootToRunning(h);

        // Run one step to a committed checkpoint (full lifecycle proof).
        const tok0 = h.runs.getRun(runId)?.fencingToken;
        expect(typeof tok0).toBe("string");
        const pending = h.runs.createStepAttempt(runId, "step-e2e-1");
        expect(pending.state).toBe("PENDING");
        h.runs.markStepReady(pending.id);
        const started = h.runs.startStepAttempt(pending.id, {
          workerLease: "worker-1",
          fencingToken: tok0 as string,
          requestHash: HASH_A,
          idempotencyKey: "e2e-key-1",
        });
        expect(started.state).toBe("STARTED");
        const tok1 = started.fencingToken;
        h.runs.finishStepAttempt(started.id, "succeeded", {
          fencingToken: tok1,
          receipt: "receipt-1",
        });
        const ckpt = h.runs.commitCheckpoint(
          runId,
          { nextStep: "step-e2e-2" },
          tok1,
        );
        expect(ckpt.runId).toBe(runId);

        // Durable events: sequence-ordered.
        const e1 = h.events.appendEvent({
          event_id: "evt-e2e-1",
          event_type: "run.started",
          node_id: NODE_ID,
          owner_id: OWNER_ID,
          agent_id: agentId,
          task_id: taskId,
          run_id: runId,
          payload: { n: 1 },
        });
        const e2 = h.events.appendEvent({
          event_id: "evt-e2e-2",
          event_type: "run.step.started",
          node_id: NODE_ID,
          owner_id: OWNER_ID,
          run_id: runId,
          payload: {},
        });
        const e3 = h.events.appendEvent({
          event_id: "evt-e2e-3",
          event_type: "run.step.completed",
          node_id: NODE_ID,
          owner_id: OWNER_ID,
          run_id: runId,
          payload: {},
        });
        expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3]);

        const live: EventEnvelope[] = [];
        const sub = h.events.subscribe(runFilter(runId), 0, (env) => {
          live.push(env);
        });
        expect(sub.kind).toBe("live");
        if (sub.kind !== "live") throw new Error("expected live subscription");
        expect(sub.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
        expect(sub.events.map((e) => e.event_id)).toEqual([
          "evt-e2e-1",
          "evt-e2e-2",
          "evt-e2e-3",
        ]);
        expect(live).toHaveLength(0);

        // event_id deduped: same id returns original envelope, no new sequence.
        const dup = h.events.appendEvent({
          event_id: "evt-e2e-2",
          event_type: "run.step.started",
          node_id: NODE_ID,
          owner_id: OWNER_ID,
          run_id: runId,
          payload: { different: true },
        });
        expect(dup.event_id).toBe(e2.event_id);
        expect(dup.sequence).toBe(e2.sequence);
        expect(h.events.getHeadSequence()).toBe(3);
        const afterDup = h.events.readEvents(runFilter(runId), 0);
        expect(afterDup.events).toHaveLength(3);
        expect(live).toHaveLength(0);

        // Live delivery after subscribe.
        const e4 = h.events.appendEvent({
          event_id: "evt-e2e-4",
          event_type: "run.completed",
          node_id: NODE_ID,
          owner_id: OWNER_ID,
          run_id: runId,
          payload: {},
        });
        expect(e4.sequence).toBe(4);
        expect(live.map((e) => e.event_id)).toEqual(["evt-e2e-4"]);
        expect(live[0]?.sequence).toBe(4);
        expect(sub.subscription.cursor()).toBe(4);

        // Ephemeral streams never replayed, never stored.
        const ephReceived: EphemeralMessage[] = [];
        const unsubEph = h.events.subscribeEphemeral(
          "message.delta",
          (m) => {
            ephReceived.push(m);
          },
          { runId },
        );
        const headBeforeEph = h.events.getHeadSequence();
        h.events.publishEphemeral("message.delta", { delta: "hello" }, runId);
        expect(ephReceived).toHaveLength(1);
        expect(ephReceived[0]?.payload).toEqual({ delta: "hello" });
        expect(h.events.getHeadSequence()).toBe(headBeforeEph);
        const replayAfterEph = h.events.readEvents(runFilter(runId), 0);
        expect(
          replayAfterEph.events.some((e) => e.event_type === "message.delta"),
        ).toBe(false);
        expect(live.some((e) => e.event_id === "evt-e2e-4")).toBe(true);
        expect(live).toHaveLength(1);

        const sub2 = h.events.subscribe(runFilter(runId), 0, () => {});
        expect(sub2.kind).toBe("live");
        if (sub2.kind !== "live") throw new Error("expected live subscription");
        expect(
          sub2.events.some((e) => e.event_type === "message.delta"),
        ).toBe(false);
        expect(sub2.events).toHaveLength(4);

        // New ephemeral subscriber gets no backlog.
        const secondEph: EphemeralMessage[] = [];
        const unsub2 = h.events.subscribeEphemeral(
          "message.delta",
          (m) => {
            secondEph.push(m);
          },
          { runId },
        );
        expect(secondEph).toHaveLength(0);
        h.events.publishEphemeral("message.delta", { delta: "world" }, runId);
        expect(secondEph).toHaveLength(1);
        expect(secondEph[0]?.counter).toBe(1);

        // Durable append of an ephemeral stream is rejected.
        expect(() =>
          h.events.appendEvent({
            event_type: "message.delta",
            node_id: NODE_ID,
            owner_id: OWNER_ID,
            payload: {},
          }),
        ).toThrow();

        sub.subscription.unsubscribe();
        if (sub2.kind === "live") sub2.subscription.unsubscribe();
        unsubEph();
        unsub2();
      } finally {
        h.close();
      }
    },
  );

  it(
    "(2) crash mid-run: epoch advances, stale fencing token -> CONFLICT",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { runId } = await bootToRunning(h);
        const epochBefore = h.runs.fencingEpoch();
        const tok0 = h.runs.getRun(runId)?.fencingToken as string;

        const a0 = h.runs.createStepAttempt(runId, "step-crash");
        h.runs.markStepReady(a0.id);
        const startedA = h.runs.startStepAttempt(a0.id, {
          workerLease: "worker-crash-1",
          fencingToken: tok0,
          requestHash: HASH_A,
          idempotencyKey: "crash-key-1",
        });
        expect(startedA.state).toBe("STARTED");
        const liveToken = startedA.fencingToken;
        expect(h.runs.getRun(runId)?.fencingToken).toBe(liveToken);
        const staleToken = tok0;
        expect(staleToken).not.toBe(liveToken);

        // Crash: drop ALL in-memory manager state, rebuild from the same DB.
        const db = h.db;
        const now = h.now;
        const headBefore = h.events.getHeadSequence();
        // Drop references (simulated crash; DB handle survives).
        let agents2: AgentManager | null = null;
        let tasks2: TaskManager | null = null;
        let runs2: RunManager | null = null;
        let events2: EventBus | null = null;
        void agents2;
        void tasks2;
        void runs2;
        void events2;
        agents2 = new AgentManager({ db, now });
        tasks2 = new TaskManager({ db, now });
        runs2 = new RunManager({ db, now });
        events2 = new EventBus(db, { nodeId: NODE_ID, nowSec: h.nowSec });

        expect(runs2.fencingEpoch()).toBeGreaterThan(epochBefore);
        expect(events2.getHeadSequence()).toBe(headBefore);
        // Durable state survived the crash.
        expect(runs2.getRun(runId)?.state).toBe("RUNNING");
        expect(runs2.getStepAttempt(startedA.id)?.state).toBe("STARTED");
        expect(runs2.getRun(runId)?.fencingToken).toBe(liveToken);

        // Stale dispatch with the pre-dispatch token -> CONFLICT.
        const b = runs2.createStepAttempt(runId, "step-crash-b");
        runs2.markStepReady(b.id);
        try {
          runs2.startStepAttempt(b.id, {
            workerLease: "worker-crash-2",
            fencingToken: staleToken,
            requestHash: HASH_B,
          });
          expect.unreachable("stale dispatch must fail");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("CONFLICT");
          expect(messageOf(err)).toMatch(/stale fencing token/);
        }

        // Stale commit of the in-flight step -> CONFLICT.
        try {
          runs2.finishStepAttempt(startedA.id, "succeeded", {
            fencingToken: staleToken,
            receipt: "receipt-stale",
          });
          expect.unreachable("stale commit must fail");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("CONFLICT");
          expect(messageOf(err)).toMatch(/stale fencing token/);
        }

        // The live token still works after the crash (recovery, not just reject).
        const c = runs2.createStepAttempt(runId, "step-crash-c");
        runs2.markStepReady(c.id);
        const startedC = runs2.startStepAttempt(c.id, {
          workerLease: "worker-crash-3",
          fencingToken: liveToken,
          requestHash: HASH_C,
        });
        expect(startedC.state).toBe("STARTED");
        const tokAfter = startedC.fencingToken;
        const finished = runs2.finishStepAttempt(startedC.id, "succeeded", {
          fencingToken: tokAfter,
          receipt: "receipt-live",
        });
        expect(finished.state).toBe("SUCCEEDED");
      } finally {
        h.close();
      }
    },
  );

  it(
    "(3) restartFromCheckpoint: new attempt, fence + reconcile, run to SUCCEEDED",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { taskId, runId } = await bootToRunning(h);
        const tok0 = h.runs.getRun(runId)?.fencingToken as string;
        const a = h.runs.createStepAttempt(runId, "step-restart-1");
        h.runs.markStepReady(a.id);
        const started = h.runs.startStepAttempt(a.id, {
          workerLease: "worker-r1",
          fencingToken: tok0,
          requestHash: HASH_A,
        });
        expect(started.state).toBe("STARTED");
        const tok1 = started.fencingToken;

        const ckpt = h.runs.commitCheckpoint(
          runId,
          { nextStep: "step-restart-2", note: "pre-restart" },
          tok1,
        );
        expect(ckpt.runId).toBe(runId);

        const epochBefore = h.runs.fencingEpoch();
        const next = h.runs.restartFromCheckpoint(runId, ckpt.id);
        expect(next.id).not.toBe(runId);
        expect(next.attemptNo).toBe(1 + 1);
        expect(next.restartOfRunId).toBe(runId);
        expect(next.fromCheckpointId).toBe(ckpt.id);
        expect(next.state).toBe("QUEUED");
        expect(h.runs.fencingEpoch()).toBeGreaterThan(epochBefore);

        // Old record is never resumed; in-flight STARTED is fenced.
        expect(h.runs.getRun(runId)?.state).toBe("RUNNING");
        const fenced = h.runs.getStepAttempt(started.id);
        expect(fenced?.state).toBe("SIDE_EFFECT_UNCERTAIN");
        expect(fenced?.reconciliation).toBe("pending");

        // Reconcile via receipt: UNCERTAIN -> RECONCILING -> SUCCEEDED.
        const reconciling = h.runs.beginReconciliation(started.id);
        expect(reconciling.state).toBe("RECONCILING");
        const resolved = h.runs.resolveReconciliation(started.id, "SUCCEEDED", {
          receipt: "provider-receipt-123",
        });
        expect(resolved.state).toBe("SUCCEEDED");
        expect(resolved.resultReceipt).toBe("provider-receipt-123");
        expect(resolved.reconciliation).toBe("resolved");

        // New attempt runs to SUCCEEDED; Task follows.
        h.runs.admit(next.id);
        h.runs.beginRunning(next.id);
        const tokNew = h.runs.getRun(next.id)?.fencingToken as string;
        const b = h.runs.createStepAttempt(next.id, "step-restart-2");
        h.runs.markStepReady(b.id);
        const sb = h.runs.startStepAttempt(b.id, {
          workerLease: "worker-r2",
          fencingToken: tokNew,
          requestHash: HASH_B,
        });
        h.runs.finishStepAttempt(sb.id, "succeeded", {
          fencingToken: sb.fencingToken,
          receipt: "receipt-new",
        });
        const done = h.runs.succeed(next.id);
        expect(done.state).toBe("SUCCEEDED");
        const taskDone = h.tasks.succeed(taskId);
        expect(taskDone.state).toBe("SUCCEEDED");
      } finally {
        h.close();
      }
    },
  );

  it(
    "(4) idempotency: same key + different args -> CONFLICT, body exactly once",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { runId } = await bootToRunning(h);
        let execCount = 0;
        const execBody = (): string => {
          execCount += 1;
          return "side-effect-ok";
        };

        const currentToken = (): string =>
          h.runs.getRun(runId)?.fencingToken as string;

        // First dispatch with key K + hash H1: executes the body once.
        const a1 = h.runs.createStepAttempt(runId, "step-idem-a");
        h.runs.markStepReady(a1.id);
        const s1 = h.runs.startStepAttempt(a1.id, {
          workerLease: "worker-idem",
          fencingToken: currentToken(),
          requestHash: HASH_A,
          idempotencyKey: "idem-key-1",
        });
        expect(s1.state).toBe("STARTED");
        execBody();
        expect(execCount).toBe(1);
        expect(h.runs.getIdempotencyReceipt("idem-key-1")?.attemptId).toBe(
          s1.id,
        );

        // Same key + same args replays the existing attempt (no second exec).
        const a2 = h.runs.createStepAttempt(runId, "step-idem-b");
        h.runs.markStepReady(a2.id);
        const replay = h.runs.startStepAttempt(a2.id, {
          workerLease: "worker-idem",
          fencingToken: currentToken(),
          requestHash: HASH_A,
          idempotencyKey: "idem-key-1",
        });
        expect(replay.id).toBe(s1.id);
        expect(execCount).toBe(1);

        // Same key + different args -> CONFLICT, body still exactly once.
        const a3 = h.runs.createStepAttempt(runId, "step-idem-c");
        h.runs.markStepReady(a3.id);
        try {
          h.runs.startStepAttempt(a3.id, {
            workerLease: "worker-idem",
            fencingToken: currentToken(),
            requestHash: HASH_B,
            idempotencyKey: "idem-key-1",
          });
          expect.unreachable("different args with same key must conflict");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("CONFLICT");
          expect(messageOf(err)).toMatch(/different args/);
        }
        expect(execCount).toBe(1);
        expect(h.runs.getIdempotencyReceipt("idem-key-1")?.requestHash).toBe(
          HASH_A,
        );
      } finally {
        h.close();
      }
    },
  );

  it(
    "(5) approval-wait: WAITING_APPROVAL -> approve -> atomic consume -> finish",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { runId } = await bootToRunning(h);
        const pending = h.runs.createStepAttempt(runId, "step-approval", {
          needsApproval: true,
        });
        expect(pending.state).toBe("WAITING_APPROVAL");

        // Cannot start while waiting without an approval.
        try {
          h.runs.startStepAttempt(pending.id, {
            workerLease: "worker-appr",
            fencingToken: h.runs.getRun(runId)?.fencingToken as string,
            requestHash: HASH_A,
          });
          expect.unreachable("start without approval must fail");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("APPROVAL_REQUIRED");
        }

        const approval = h.runs.registerApproval({
          actionHash: ACTION_HASH,
          runId,
          stepId: "step-approval",
        });
        expect(approval.state).toBe("PENDING");
        const approved = h.runs.approveApproval(approval.id);
        expect(approved.state).toBe("APPROVED");

        const tok = h.runs.getRun(runId)?.fencingToken as string;
        const started = h.runs.startStepAttempt(pending.id, {
          workerLease: "worker-appr",
          fencingToken: tok,
          requestHash: HASH_A,
          approvalRef: approval.id,
          actionHash: ACTION_HASH,
        });
        expect(started.state).toBe("STARTED");
        // Atomic consume: approval CONSUMED by this attempt in the same unit.
        const consumed = h.runs.getApproval(approval.id);
        expect(consumed?.state).toBe("CONSUMED");
        expect(consumed?.consumedByAttemptId).toBe(pending.id);

        // Reusing the consumed approval is rejected.
        const other = h.runs.createStepAttempt(runId, "step-approval-2", {
          needsApproval: true,
        });
        expect(other.state).toBe("WAITING_APPROVAL");
        try {
          h.runs.startStepAttempt(other.id, {
            workerLease: "worker-appr",
            fencingToken: h.runs.getRun(runId)?.fencingToken as string,
            requestHash: HASH_B,
            approvalRef: approval.id,
            actionHash: ACTION_HASH,
          });
          expect.unreachable("consumed approval must not be reusable");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("APPROVAL_INVALID");
        }

        const finished = h.runs.finishStepAttempt(started.id, "succeeded", {
          fencingToken: started.fencingToken,
          receipt: "receipt-approval",
        });
        expect(finished.state).toBe("SUCCEEDED");

        // Mismatched action hash is rejected (uses a fresh approval).
        const approval2 = h.runs.registerApproval({
          actionHash: ACTION_HASH_2,
          runId,
          stepId: "step-approval-2",
        });
        h.runs.approveApproval(approval2.id);
        try {
          h.runs.startStepAttempt(other.id, {
            workerLease: "worker-appr",
            fencingToken: h.runs.getRun(runId)?.fencingToken as string,
            requestHash: HASH_B,
            approvalRef: approval2.id,
            actionHash: ACTION_HASH,
          });
          expect.unreachable("action hash mismatch must fail");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("APPROVAL_INVALID");
        }
      } finally {
        h.close();
      }
    },
  );

  it(
    "(6) terminal Runs/Tasks never resume (new attempt required)",
    { timeout: 30_000 },
    async () => {
      const h = newHarness();
      try {
        const { agentId, taskId, runId } = await bootToRunning(h);

        // Drive the first run to a checkpoint, then to SUCCEEDED.
        const t0 = h.runs.getRun(runId)?.fencingToken as string;
        const a = h.runs.createStepAttempt(runId, "step-terminal");
        h.runs.markStepReady(a.id);
        const s = h.runs.startStepAttempt(a.id, {
          workerLease: "worker-term",
          fencingToken: t0,
          requestHash: HASH_A,
        });
        h.runs.finishStepAttempt(s.id, "succeeded", {
          fencingToken: s.fencingToken,
        });
        const ckpt = h.runs.commitCheckpoint(
          runId,
          { nextStep: "step-terminal-2" },
          s.fencingToken,
        );
        const succeeded = h.runs.succeed(runId);
        expect(succeeded.state).toBe("SUCCEEDED");

        // Terminal run never resumes.
        try {
          h.runs.transitionRun(runId, "RUNNING");
          expect.unreachable("terminal run must not resume");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
          expect(messageOf(err)).toMatch(/never resume/);
        }
        try {
          h.runs.createStepAttempt(runId, "step-after-terminal");
          expect.unreachable("no new steps on a terminal run");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
        }

        // New attempt required: restart from the checkpoint.
        const next = h.runs.restartFromCheckpoint(runId, ckpt.id);
        expect(next.attemptNo).toBe(2);
        expect(next.restartOfRunId).toBe(runId);
        expect(next.fromCheckpointId).toBe(ckpt.id);
        expect(next.state).toBe("QUEUED");
        h.runs.admit(next.id);
        h.runs.beginRunning(next.id);
        expect(h.runs.getRun(next.id)?.state).toBe("RUNNING");

        // Terminal task never resumes.
        const taskDone = h.tasks.succeed(taskId);
        expect(taskDone.state).toBe("SUCCEEDED");
        try {
          h.tasks.transitionTo(taskId, "RUNNABLE");
          expect.unreachable("terminal task must not resume");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
          expect(messageOf(err)).toMatch(/never resume/);
        }
        try {
          h.tasks.retry(taskId);
          expect.unreachable("terminal task retry must fail");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
        }

        // Owner restart of a terminal task is a successor, not a resume.
        const successor = h.tasks.restartAsSuccessor(taskId);
        expect(successor.id).not.toBe(taskId);
        expect(successor.restartedFromTaskId).toBe(taskId);
        expect(successor.state).toBe("PENDING");
        h.tasks.makeRunnable(successor.id);
        h.tasks.start(successor.id);
        expect(h.tasks.get(successor.id)?.state).toBe("RUNNING");

        // FAILED and CANCELLED are terminal too (fresh records, same DB).
        const failTask = h.tasks.create(agentId, { title: "fail task" });
        h.tasks.makeRunnable(failTask.id);
        h.tasks.start(failTask.id);
        h.tasks.fail(failTask.id);
        expect(h.tasks.get(failTask.id)?.state).toBe("FAILED");
        try {
          h.tasks.transitionTo(failTask.id, "RUNNABLE");
          expect.unreachable("FAILED task must not resume");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
        }

        const cancelRun = h.runs.createRun({
          taskId: successor.id,
          agentId,
        });
        h.runs.transitionRun(cancelRun.id, "CANCELLED");
        expect(h.runs.getRun(cancelRun.id)?.state).toBe("CANCELLED");
        try {
          h.runs.transitionRun(cancelRun.id, "RUNNING");
          expect.unreachable("CANCELLED run must not resume");
        } catch (err: unknown) {
          expect(codeOf(err)).toBe("INVALID_ARGUMENT");
        }
      } finally {
        h.close();
      }
    },
  );
});
