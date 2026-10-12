import type { IFileSystem } from "just-bash";
import { fsError } from "./fs.js";

const WRITES = [
  "writeFile",
  "appendFile",
  "mkdir",
  "createExclusive",
  "rm",
  "cp",
  "mv",
  "chmod",
  "symlink",
  "link",
  "utimes",
] as const;

/**
 * The same files, but every write fails with "read-only file system".
 * `mountPoint` is prefixed to paths in errors, so they match what the agent typed.
 */
export function readOnly(fs: IFileSystem, mountPoint = ""): IFileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if ((WRITES as readonly PropertyKey[]).includes(prop)) {
        return async (...args: unknown[]) => {
          const path = String(prop === "cp" || prop === "mv" || prop === "link" ? args[1] : args[0]);
          throw fsError("EROFS", String(prop), mountPoint + (path === "/" && mountPoint ? "" : path));
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
