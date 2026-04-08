import { Filesystem } from "../src/filesystem.js";
import { getTools } from "../src/tools.js";
import { MemoryStore } from "./memory-store.js";
import { PROJECT_FILES } from "./seed.js";
import { TASKS, type EvalTask } from "./tasks.js";
import { runAgent } from "./agent.js";

// ─── config ────────────────────────────────────────────────

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-20250514";
const TASK_FILTER = process.argv[2]; // optional: run a single task by name

// ─── runner ────────────────────────────────────────────────

async function runTask(task: EvalTask) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TASK: ${task.name}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Prompt: ${task.prompt.slice(0, 100)}...`);

  // Fresh store for each task
  const store = new MemoryStore();
  store.seed(PROJECT_FILES);

  const fs = new Filesystem({
    bucket: "eval",
    client: store as any,
  });

  const tools = getTools(fs);

  console.log(`  Model: ${MODEL}`);
  console.log(`  Running agent...`);

  const startTime = Date.now();
  const result = await runAgent({
    task: task.prompt,
    tools,
    model: MODEL,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Turns: ${result.turns} | Tool calls: ${result.toolCalls.length} | Time: ${elapsed}s`);
  console.log();

  // Log tool calls
  for (const call of result.toolCalls) {
    const inputStr = JSON.stringify(call.input);
    const truncInput = inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr;
    const truncOutput =
      call.output.length > 60 ? call.output.slice(0, 60) + "..." : call.output;
    console.log(`  ${call.name}(${truncInput})`);
    console.log(`    → ${truncOutput}`);
  }

  // Verify
  console.log();
  const verification = await task.verify(fs);

  if (verification.pass) {
    console.log(`  ✓ PASS: ${verification.reason}`);
  } else {
    console.log(`  ✗ FAIL: ${verification.reason}`);
  }

  // Log the agent's final text response
  if (result.finalResponse) {
    console.log();
    console.log(`  Agent response:`);
    for (const line of result.finalResponse.split("\n").slice(0, 10)) {
      console.log(`    ${line}`);
    }
    if (result.finalResponse.split("\n").length > 10) {
      console.log(`    ... (truncated)`);
    }
  }

  return verification.pass;
}

// ─── main ──────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  const tasksToRun = TASK_FILTER
    ? TASKS.filter((t) => t.name === TASK_FILTER)
    : TASKS;

  if (tasksToRun.length === 0) {
    console.error(`No task found matching "${TASK_FILTER}"`);
    console.error(`Available tasks: ${TASKS.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`s3fs-agent eval`);
  console.log(`Running ${tasksToRun.length} task(s) with ${MODEL}`);

  let passed = 0;
  let failed = 0;

  for (const task of tasksToRun) {
    try {
      const pass = await runTask(task);
      if (pass) passed++;
      else failed++;
    } catch (err) {
      console.error(`  ✗ ERROR: ${err}`);
      failed++;
    }
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${tasksToRun.length}`);
  console.log(`${"═".repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
