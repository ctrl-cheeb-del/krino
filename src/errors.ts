export class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(path: string) {
    super(`Conflict: ${path} was modified by another process`);
    this.name = "ConflictError";
  }
}

export class DirectoryNotEmptyError extends Error {
  readonly code = "DIR_NOT_EMPTY" as const;
  constructor(path: string) {
    super(`Directory not empty: ${path}`);
    this.name = "DirectoryNotEmptyError";
  }
}
