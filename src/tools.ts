import type { Filesystem } from "./filesystem.js";
import type { ToolDefinition } from "./types.js";
import { NotFoundError, ConflictError, DirectoryNotEmptyError } from "./errors.js";

/**
 * Sanitize any error into a safe string for the model.
 * Never leaks bucket names, S3 keys, endpoints, or AWS internals.
 */
function safeError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof DirectoryNotEmptyError) return err.message;
  if (err instanceof ConflictError) return err.message;
  // Catch-all: never pass raw AWS SDK errors to the model
  return "Operation failed. Please try again.";
}

export function getTools(fs: Filesystem): ToolDefinition[] {
  return [
    {
      name: "read_file",
      description:
        "Read the contents of a file at the given path. Returns the file content as a string.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, absolute or relative to current working directory",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          const result = await fs.readFile(input.path as string);
          return result.content;
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "write_file",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, absolute or relative to current working directory",
          },
          content: {
            type: "string",
            description: "The text content to write",
          },
        },
        required: ["path", "content"],
      },
      execute: async (input) => {
        try {
          await fs.writeFile(input.path as string, input.content as string);
          return "File written successfully.";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "delete_file",
      description:
        "Delete a file at the given path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to delete",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          await fs.deleteFile(input.path as string);
          return "File deleted.";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "file_exists",
      description:
        "Check whether a file or directory exists at the given path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to check",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          const exists = await fs.exists(input.path as string);
          return exists ? "true" : "false";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "list_directory",
      description:
        "List files and subdirectories in a directory. Lists the current working directory if no path is given.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default: current working directory)",
          },
        },
        required: [],
      },
      execute: async (input) => {
        try {
          const entries = await fs.listDir(input.path as string | undefined);
          if (entries.length === 0) return "(empty directory)";
          return entries
            .map((e) => {
              if (e.type === "directory") return `${e.name}/`;
              return e.name;
            })
            .join("\n");
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "create_directory",
      description:
        "Create a directory at the given path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to create",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          await fs.mkdir(input.path as string);
          return "Directory created.";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "remove_directory",
      description:
        "Remove a directory. Fails if the directory is not empty unless recursive is true.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to remove",
          },
          recursive: {
            type: "boolean",
            description: "If true, delete all contents recursively (default: false)",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          await fs.rmdir(
            input.path as string,
            (input.recursive as boolean) ?? false,
          );
          return "Directory removed.";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "move_file",
      description:
        "Move or rename a file from one path to another.",
      inputSchema: {
        type: "object",
        properties: {
          from_path: {
            type: "string",
            description: "Source file path",
          },
          to_path: {
            type: "string",
            description: "Destination file path",
          },
        },
        required: ["from_path", "to_path"],
      },
      execute: async (input) => {
        try {
          await fs.move(input.from_path as string, input.to_path as string);
          return "File moved.";
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
    {
      name: "change_directory",
      description:
        "Change the current working directory. Subsequent relative paths resolve from here.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "New working directory path",
          },
        },
        required: ["path"],
      },
      execute: async (input) => {
        try {
          fs.cd(input.path as string);
          return fs.cwd;
        } catch (err) {
          return `Error: ${safeError(err)}`;
        }
      },
    },
  ];
}
