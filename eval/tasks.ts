import type { Filesystem } from "../src/filesystem.js";

export interface EvalTask {
  name: string;
  prompt: string;
  verify: (fs: Filesystem) => Promise<{ pass: boolean; reason: string }>;
}

export const TASKS: EvalTask[] = [
  {
    name: "explore-and-describe",
    prompt:
      "Explore this project. List the directory structure, read a few key files, " +
      "and tell me what this project is and what framework it uses.",
    verify: async () => {
      // This task just tests navigation — pass if the agent didn't error
      return { pass: true, reason: "Navigation task — verified by agent completing" };
    },
  },

  {
    name: "create-component",
    prompt:
      "Create a new Button component at src/components/button.tsx. " +
      "It should accept `label` (string) and `onClick` (function) props. " +
      "Use inline styles consistent with the rest of the project.",
    verify: async (fs) => {
      try {
        const { content } = await fs.readFile("/src/components/button.tsx");
        const checks = [
          [content.includes("Button"), "exports a Button component"],
          [content.includes("label"), "accepts label prop"],
          [content.includes("onClick"), "accepts onClick prop"],
          [content.includes("export"), "has an export"],
        ] as const;

        const failed = checks.filter(([pass]) => !pass);
        if (failed.length > 0) {
          return {
            pass: false,
            reason: `Missing: ${failed.map(([, r]) => r).join(", ")}`,
          };
        }
        return { pass: true, reason: "Button component created with correct props" };
      } catch {
        return { pass: false, reason: "src/components/button.tsx was not created" };
      }
    },
  },

  {
    name: "edit-existing-page",
    prompt:
      "Update the home page (src/app/page.tsx) to add a new dashboard card " +
      'for "Orders" showing "3,241 pending orders". Keep the existing cards intact.',
    verify: async (fs) => {
      try {
        const { content } = await fs.readFile("/src/app/page.tsx");
        const checks = [
          [content.includes("Orders"), 'contains "Orders"'],
          [content.includes("3,241") || content.includes("3241"), "contains order count"],
          [content.includes("Users"), "preserved existing Users card"],
          [content.includes("Revenue"), "preserved existing Revenue card"],
          [content.includes("Header"), "preserved Header import"],
        ] as const;

        const failed = checks.filter(([pass]) => !pass);
        if (failed.length > 0) {
          return {
            pass: false,
            reason: `Failed: ${failed.map(([, r]) => r).join(", ")}`,
          };
        }
        return { pass: true, reason: "Home page updated with Orders card, existing content preserved" };
      } catch {
        return { pass: false, reason: "Could not read src/app/page.tsx" };
      }
    },
  },

  {
    name: "create-new-page",
    prompt:
      "Create a new settings page at src/app/settings/page.tsx. " +
      "It should have a form with fields for 'Display Name' and 'Email', " +
      "plus a save button. Use the Header and Footer components like the other pages do. " +
      "Also add a 'Settings' link to the navigation in the Header component.",
    verify: async (fs) => {
      const results: string[] = [];
      let pass = true;

      // Check settings page exists
      try {
        const { content } = await fs.readFile("/src/app/settings/page.tsx");
        if (!content.includes("Display Name") && !content.includes("display_name") && !content.includes("displayName")) {
          results.push("settings page missing Display Name field");
          pass = false;
        }
        if (!content.includes("Email") && !content.includes("email")) {
          results.push("settings page missing Email field");
          pass = false;
        }
        if (!content.includes("Header")) {
          results.push("settings page missing Header component");
          pass = false;
        }
      } catch {
        results.push("src/app/settings/page.tsx was not created");
        pass = false;
      }

      // Check header was updated with Settings link
      try {
        const { content } = await fs.readFile("/src/components/header.tsx");
        if (!content.includes("settings") && !content.includes("Settings")) {
          results.push("Header not updated with Settings link");
          pass = false;
        }
      } catch {
        results.push("Could not read header.tsx");
        pass = false;
      }

      return {
        pass,
        reason: pass
          ? "Settings page created with form fields, Header updated with nav link"
          : results.join("; "),
      };
    },
  },

  {
    name: "multi-file-refactor",
    prompt:
      "The utils.ts file has a formatCurrency function. " +
      "Create a new file src/lib/format.ts and move ONLY the formatCurrency and formatNumber " +
      "functions there. Update utils.ts to re-export them from the new file so existing imports don't break. " +
      "Read the files first to understand the current structure.",
    verify: async (fs) => {
      const results: string[] = [];
      let pass = true;

      // Check new file exists with the functions
      try {
        const { content } = await fs.readFile("/src/lib/format.ts");
        if (!content.includes("formatCurrency")) {
          results.push("format.ts missing formatCurrency");
          pass = false;
        }
        if (!content.includes("formatNumber")) {
          results.push("format.ts missing formatNumber");
          pass = false;
        }
      } catch {
        results.push("src/lib/format.ts was not created");
        pass = false;
      }

      // Check utils.ts still re-exports
      try {
        const { content } = await fs.readFile("/src/lib/utils.ts");
        if (!content.includes("formatCurrency")) {
          results.push("utils.ts no longer exports formatCurrency (would break imports)");
          pass = false;
        }
        if (!content.includes("classNames")) {
          results.push("utils.ts lost classNames function");
          pass = false;
        }
      } catch {
        results.push("Could not read utils.ts");
        pass = false;
      }

      return {
        pass,
        reason: pass
          ? "Functions moved to format.ts, re-exported from utils.ts"
          : results.join("; "),
      };
    },
  },
];
