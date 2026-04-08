import { vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

type CommandHandler = (input: any) => any;

/**
 * Creates a mock S3Client that dispatches `send()` calls by command class name.
 * Register handlers like: `{ GetObjectCommand: (input) => ({ Body: ..., ETag: ... }) }`
 */
export function createMockClient(
  handlers: Record<string, CommandHandler> = {},
): S3Client & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (command: any) => {
    const name = command.constructor.name;
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`Unmocked command: ${name}`);
    }
    return handler(command.input);
  });
  return { send } as any;
}

/** Helper to create a readable stream-like body that supports transformToString */
export function mockBody(content: string) {
  return {
    transformToString: async () => content,
  };
}

/** Helper to create an S3 error with a specific name */
export function s3Error(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
