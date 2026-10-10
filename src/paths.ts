/** Absolute POSIX path with `.`/`..` collapsed; `..` past root stays at root. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function resolve(base: string, path: string): string {
  return normalize(path.startsWith("/") ? path : `${base}/${path}`);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** True when `path` is `dir` itself or anywhere beneath it. */
export function isWithin(path: string, dir: string): boolean {
  return dir === "/" || path === dir || path.startsWith(`${dir}/`);
}
