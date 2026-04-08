import Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition } from "../src/types.js";

export interface AgentResult {
  turns: number;
  toolCalls: { name: string; input: Record<string, unknown>; output: string }[];
  finalResponse: string;
}

/**
 * Run an agent loop: give Claude a task and tools, let it work until done.
 */
export async function runAgent(opts: {
  task: string;
  tools: ToolDefinition[];
  model?: string;
  maxTurns?: number;
}): Promise<AgentResult> {
  const anthropic = new Anthropic();
  const model = opts.model ?? "claude-sonnet-4-20250514";
  const maxTurns = opts.maxTurns ?? 20;

  const anthropicTools = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const toolCalls: AgentResult["toolCalls"] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.task },
  ];

  let turns = 0;
  let finalResponse = "";

  while (turns < maxTurns) {
    turns++;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system:
        "You are a developer working in a project directory. You have access to a filesystem with standard tools. " +
        "Explore the codebase, read files to understand the structure, then make the requested changes. " +
        "Always read a file before editing it. Write complete file contents when using write_file.",
      tools: anthropicTools,
      messages,
    });

    // Collect text blocks for final response
    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);
    finalResponse = textBlocks.join("\n");

    // If no tool use, we're done
    if (response.stop_reason === "end_turn") break;

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) break;

    // Add assistant message
    messages.push({ role: "assistant", content: response.content });

    // Execute tools and build tool results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const tool = toolMap.get(block.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: Unknown tool ${block.name}`,
        });
        continue;
      }

      const input = block.input as Record<string, unknown>;
      const output = await tool.execute(input);

      toolCalls.push({ name: block.name, input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { turns, toolCalls, finalResponse };
}
