/**
 * Full end-to-end demo: seed a SaaS boilerplate to R2, run an agent
 * that navigates and edits it, verify the changes in R2.
 *
 * Runs two modes:
 *   1. Filesystem tools only (read_file, write_file, list_directory, etc.)
 *   2. Shell tool only (run_command with ls, cat, grep, etc.)
 *
 * Usage:
 *   npx tsx eval/r2-demo.ts              # both modes
 *   npx tsx eval/r2-demo.ts tools        # filesystem tools only
 *   npx tsx eval/r2-demo.ts shell        # shell tool only
 */

import Anthropic from "@anthropic-ai/sdk";
import { Filesystem, getTools, getShellTool } from "../src/index.js";
import type { ToolDefinition } from "../src/types.js";
import { SAAS_FILES } from "./saas-boilerplate.js";

// ─── config ────────────────────────────────────────────────

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const BUCKET = process.env.R2_BUCKET!;
const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-20250514";
const MODE = process.argv[2] as "tools" | "shell" | undefined;

const TASK =
  "You are a developer working on the Launchpad SaaS boilerplate. " +
  "I need you to do the following:\n\n" +
  "1. Explore the project structure to understand the codebase\n" +
  "2. Find the pricing page component\n" +
  "3. Update the Pro plan price from $29/month to $49/month\n" +
  "4. Update the Pro plan to include 'Priority email support' instead of 'Priority support'\n" +
  "5. Add a new feature to the Pro plan: 'API webhooks'\n\n" +
  "Read the relevant files first to understand the codebase before making changes.";

// ─── helpers ───────────────────────────────────────────────

async function seedR2(fs: Filesystem): Promise<void> {
  console.log("  Seeding files to R2...");
  let count = 0;
  for (const [path, content] of Object.entries(SAAS_FILES)) {
    // writeFile needs the path from root; the prefix handles namespacing
    await fs.writeFile("/" + path, content);
    count++;
  }
  console.log(`  Seeded ${count} files.`);
}

async function cleanupR2(fs: Filesystem): Promise<void> {
  console.log("  Cleaning up R2...");
  await fs.rmdir("/", true);
  console.log("  Done.");
}

async function runAgentLoop(tools: ToolDefinition[], task: string): Promise<{
  turns: number;
  toolCalls: { name: string; input: any; output: string }[];
  finalResponse: string;
}> {
  const anthropic = new Anthropic();
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolCalls: { name: string; input: any; output: string }[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  let turns = 0;
  let finalResponse = "";

  while (turns < 30) {
    turns++;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        "You are a developer working in a project directory. " +
        "You have access to a filesystem. Explore the codebase, read files to understand the structure, then make changes. " +
        "Always read a file before editing it. Write complete file contents when writing files.",
      tools: anthropicTools,
      messages,
    });

    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);
    finalResponse = textBlocks.join("\n");

    if (response.stop_reason === "end_turn") break;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const tool = toolMap.get(block.name);
      const input = block.input as Record<string, unknown>;
      const output = tool
        ? await tool.execute(input)
        : `Error: unknown tool ${block.name}`;
      toolCalls.push({ name: block.name, input, output });
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { turns, toolCalls, finalResponse };
}

// ─── verification ──────────────────────────────────────────

async function verify(fs: Filesystem): Promise<{ pass: boolean; details: string[] }> {
  const details: string[] = [];
  let pass = true;

  try {
    const { content } = await fs.readFile("/src/components/landing/pricing.tsx");

    if (content.includes("$49")) {
      details.push("✓ Pro plan price updated to $49");
    } else {
      details.push("✗ Pro plan price NOT updated to $49");
      pass = false;
    }

    if (!content.includes("$29")) {
      details.push("✓ Old $29 price removed");
    } else {
      details.push("✗ Old $29 price still present");
      pass = false;
    }

    if (content.includes("Priority email support")) {
      details.push("✓ 'Priority email support' added");
    } else {
      details.push("✗ 'Priority email support' NOT found");
      pass = false;
    }

    if (content.includes("API webhooks")) {
      details.push("✓ 'API webhooks' feature added");
    } else {
      details.push("✗ 'API webhooks' NOT found");
      pass = false;
    }

    // Sanity: other plans should still be there
    if (content.includes("Starter") && content.includes("Enterprise")) {
      details.push("✓ Starter and Enterprise plans preserved");
    } else {
      details.push("✗ Other plans may have been damaged");
      pass = false;
    }

    if (content.includes("$0") && content.includes("$99")) {
      details.push("✓ Starter ($0) and Enterprise ($99) prices intact");
    } else {
      details.push("✗ Other plan prices changed");
      pass = false;
    }
  } catch (err) {
    details.push(`✗ Could not read pricing.tsx: ${err}`);
    pass = false;
  }

  return { pass, details };
}

// ─── run one mode ──────────────────────────────────────────

async function runMode(mode: "tools" | "shell") {
  const prefix = `s3fs-demo-${mode}-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MODE: ${mode === "tools" ? "Filesystem Tools" : "Shell Tool (bash)"}`);
  console.log(`  Prefix: ${prefix}`);
  console.log(`${"═".repeat(60)}\n`);

  const fs = new Filesystem({
    bucket: BUCKET,
    prefix,
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    region: "auto",
  });

  // Seed
  await seedR2(fs);

  // Build tools
  const tools: ToolDefinition[] =
    mode === "tools"
      ? getTools(fs)
      : [getShellTool(fs)];

  console.log(`  Tools: ${tools.map((t) => t.name).join(", ")}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Running agent...\n`);

  const startTime = Date.now();
  const result = await runAgentLoop(tools, TASK);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Turns: ${result.turns} | Tool calls: ${result.toolCalls.length} | Time: ${elapsed}s\n`);

  // Log tool calls
  for (const call of result.toolCalls) {
    const inputStr = typeof call.input === "string" ? call.input : JSON.stringify(call.input);
    const truncInput = inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr;
    const truncOutput = call.output.length > 60 ? call.output.slice(0, 60) + "..." : call.output;
    console.log(`  ${call.name}(${truncInput})`);
    console.log(`    → ${truncOutput}`);
  }

  // Verify directly from R2
  console.log(`\n  Verifying changes in R2...`);
  const { pass, details } = await verify(fs);
  for (const d of details) {
    console.log(`  ${d}`);
  }
  console.log(`\n  ${pass ? "✓ PASS" : "✗ FAIL"}`);

  // Agent response
  if (result.finalResponse) {
    console.log(`\n  Agent response (first 8 lines):`);
    for (const line of result.finalResponse.split("\n").slice(0, 8)) {
      console.log(`    ${line}`);
    }
  }

  // Cleanup
  console.log();
  await cleanupR2(fs);

  return pass;
}

// ─── main ──────────────────────────────────────────────────

async function main() {
  for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ANTHROPIC_API_KEY"]) {
    if (!process.env[key]) {
      console.error(`Missing env var: ${key}`);
      process.exit(1);
    }
  }

  const modes: ("tools" | "shell")[] =
    MODE ? [MODE] : ["tools", "shell"];

  console.log(`\ns3fs-agent R2 Demo`);
  console.log(`Running ${modes.length} mode(s) against real R2\n`);

  const results: Record<string, boolean> = {};

  for (const mode of modes) {
    results[mode] = await runMode(mode);
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  for (const [mode, pass] of Object.entries(results)) {
    console.log(`  ${pass ? "✓" : "✗"} ${mode}`);
  }
  console.log(`${"═".repeat(60)}\n`);

  const allPassed = Object.values(results).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
