import { describe, it, expect } from "vitest";
import { NotFoundError, ConflictError, DirectoryNotEmptyError } from "../errors.js";

describe("NotFoundError", () => {
  it("extends Error", () => {
    expect(new NotFoundError("/x")).toBeInstanceOf(Error);
  });

  it("has name NotFoundError", () => {
    expect(new NotFoundError("/x").name).toBe("NotFoundError");
  });

  it("has code NOT_FOUND", () => {
    expect(new NotFoundError("/x").code).toBe("NOT_FOUND");
  });

  it("includes path in message", () => {
    expect(new NotFoundError("/foo/bar.txt").message).toBe("Not found: /foo/bar.txt");
  });
});

describe("ConflictError", () => {
  it("extends Error", () => {
    expect(new ConflictError("/x")).toBeInstanceOf(Error);
  });

  it("has name ConflictError", () => {
    expect(new ConflictError("/x").name).toBe("ConflictError");
  });

  it("has code CONFLICT", () => {
    expect(new ConflictError("/x").code).toBe("CONFLICT");
  });

  it("includes path in message", () => {
    expect(new ConflictError("/f.txt").message).toContain("/f.txt");
  });

  it("does not mention ETag in message", () => {
    const msg = new ConflictError("/f.txt").message.toLowerCase();
    expect(msg).not.toContain("etag");
  });
});

describe("DirectoryNotEmptyError", () => {
  it("extends Error", () => {
    expect(new DirectoryNotEmptyError("/d")).toBeInstanceOf(Error);
  });

  it("has name DirectoryNotEmptyError", () => {
    expect(new DirectoryNotEmptyError("/d").name).toBe("DirectoryNotEmptyError");
  });

  it("has code DIR_NOT_EMPTY", () => {
    expect(new DirectoryNotEmptyError("/d").code).toBe("DIR_NOT_EMPTY");
  });

  it("includes path in message", () => {
    expect(new DirectoryNotEmptyError("/mydir").message).toContain("/mydir");
  });
});
