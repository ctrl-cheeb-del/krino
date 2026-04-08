import { describe, it, expect } from "vitest";
import { resolvePath, toDisplayPath } from "../paths.js";

// ─── resolvePath ───────────────────────────────────────────

describe("resolvePath", () => {
  describe("absolute vs relative", () => {
    it("absolute paths ignore cwd", () => {
      expect(resolvePath("/some/cwd", "/foo/bar.txt", "")).toBe("foo/bar.txt");
    });

    it("relative paths join with cwd", () => {
      expect(resolvePath("/workspace", "notes.txt", "")).toBe("workspace/notes.txt");
    });

    it("leading / makes it absolute regardless of cwd", () => {
      expect(resolvePath("/deeply/nested/cwd", "/top.txt", "")).toBe("top.txt");
    });

    it("no leading / is relative", () => {
      expect(resolvePath("/a/b", "c/d.txt", "")).toBe("a/b/c/d.txt");
    });
  });

  describe("dot segments", () => {
    it("resolves single . segments", () => {
      expect(resolvePath("/", "./foo/./bar", "")).toBe("foo/bar");
    });

    it("resolves .. segments", () => {
      expect(resolvePath("/foo/bar", "../baz.txt", "")).toBe("foo/baz.txt");
    });

    it("resolves multiple consecutive .. segments", () => {
      expect(resolvePath("/a/b/c/d", "../../../x.txt", "")).toBe("a/x.txt");
    });

    it("resolves mixed . and .. segments", () => {
      expect(resolvePath("/a/b/c", "./../d/./e/../f", "")).toBe("a/b/d/f");
    });

    it("clamps .. at root with no prefix", () => {
      expect(resolvePath("/", "../../foo", "")).toBe("foo");
    });

    it("clamps .. at root from deep cwd", () => {
      expect(resolvePath("/a", "../../../x", "")).toBe("x");
    });

    it("clamps .. at root and prefix is still prepended", () => {
      expect(resolvePath("/", "../../../secret", "agents/bob")).toBe("agents/bob/secret");
    });

    it("resolves . as current directory", () => {
      expect(resolvePath("/workspace", ".", "")).toBe("workspace");
    });

    it("triple dots ... treated as literal segment name", () => {
      expect(resolvePath("/", "foo/.../bar", "")).toBe("foo/.../bar");
    });
  });

  describe("prefix handling", () => {
    it("prepends prefix to resolved path", () => {
      expect(resolvePath("/", "file.txt", "agents/bob")).toBe("agents/bob/file.txt");
    });

    it("handles prefix with trailing slash", () => {
      expect(resolvePath("/", "file.txt", "agents/bob/")).toBe("agents/bob/file.txt");
    });

    it("handles prefix with multiple trailing slashes", () => {
      expect(resolvePath("/", "file.txt", "agents/bob///")).toBe("agents/bob/file.txt");
    });

    it("root path with prefix returns just prefix", () => {
      expect(resolvePath("/", "/", "myprefix")).toBe("myprefix");
    });

    it("root path with no prefix returns empty string", () => {
      expect(resolvePath("/", "/", "")).toBe("");
    });

    it("prefix is always prepended — agent cannot escape via ..", () => {
      expect(resolvePath("/", "../../../etc/passwd", "sandbox")).toBe("sandbox/etc/passwd");
    });

    it("prefix is always prepended — agent cannot escape via absolute path", () => {
      expect(resolvePath("/", "/etc/passwd", "sandbox")).toBe("sandbox/etc/passwd");
    });

    it("complex relative path with prefix", () => {
      expect(resolvePath("/a/b/c", "../../d/./e", "pfx")).toBe("pfx/a/d/e");
    });
  });

  describe("normalization", () => {
    it("strips double slashes", () => {
      expect(resolvePath("/foo//bar", "baz", "")).toBe("foo/bar/baz");
    });

    it("strips trailing slashes in input path", () => {
      expect(resolvePath("/", "foo/bar/", "")).toBe("foo/bar");
    });

    it("strips leading slash from final S3 key", () => {
      const result = resolvePath("/", "/file.txt", "");
      expect(result).not.toMatch(/^\//);
    });

    it("handles many consecutive slashes", () => {
      expect(resolvePath("///a///b///", "///c///", "")).toBe("c");
    });
  });

  describe("edge cases", () => {
    it("empty input path resolves to cwd", () => {
      expect(resolvePath("/workspace", "", "")).toBe("workspace");
    });

    it("empty input path with prefix", () => {
      expect(resolvePath("/workspace", "", "pfx")).toBe("pfx/workspace");
    });

    it("paths with spaces", () => {
      expect(resolvePath("/my dir", "my file.txt", "")).toBe("my dir/my file.txt");
    });

    it("paths with unicode", () => {
      expect(resolvePath("/", "日本語/ファイル.txt", "")).toBe("日本語/ファイル.txt");
    });

    it("deeply nested path", () => {
      expect(resolvePath("/", "a/b/c/d/e/f/g/h/i/j.txt", "")).toBe("a/b/c/d/e/f/g/h/i/j.txt");
    });

    it("cwd at root, path is just a filename", () => {
      expect(resolvePath("/", "readme.md", "")).toBe("readme.md");
    });

    it("cwd without leading slash still works", () => {
      // resolvePath joins cwd + input; if cwd lacks /, the split/filter handles it
      expect(resolvePath("workspace", "file.txt", "")).toBe("workspace/file.txt");
    });
  });
});

// ─── toDisplayPath ─────────────────────────────────────────

describe("toDisplayPath", () => {
  it("strips prefix and prepends /", () => {
    expect(toDisplayPath("agents/bob/file.txt", "agents/bob")).toBe("/file.txt");
  });

  it("handles no prefix", () => {
    expect(toDisplayPath("foo/bar.txt", "")).toBe("/foo/bar.txt");
  });

  it("handles prefix with trailing slash", () => {
    expect(toDisplayPath("pfx/file.txt", "pfx/")).toBe("/file.txt");
  });

  it("returns / for root key matching prefix", () => {
    expect(toDisplayPath("pfx", "pfx")).toBe("/");
  });

  it("handles deeply nested paths", () => {
    expect(toDisplayPath("pfx/a/b/c/d.txt", "pfx")).toBe("/a/b/c/d.txt");
  });

  it("handles key that doesn't start with prefix (fallback)", () => {
    expect(toDisplayPath("other/path.txt", "pfx")).toBe("/other/path.txt");
  });

  it("handles empty key with no prefix", () => {
    expect(toDisplayPath("", "")).toBe("/");
  });

  it("handles empty key with prefix", () => {
    expect(toDisplayPath("", "pfx")).toBe("/");
  });
});
