/**
 * A realistic Next.js project to seed into the filesystem.
 * The model will think it's in a sandbox with this project.
 */
export const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "acme-dashboard",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        lint: "next lint",
      },
      dependencies: {
        next: "14.2.0",
        react: "^18.3.0",
        "react-dom": "^18.3.0",
      },
      devDependencies: {
        "@types/node": "^20",
        "@types/react": "^18",
        typescript: "^5",
      },
    },
    null,
    2,
  ),

  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "es5",
        lib: ["dom", "es2017"],
        jsx: "preserve",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
    },
    null,
    2,
  ),

  "next.config.js": `/** @type {import('next').NextConfig} */
const nextConfig = {};
module.exports = nextConfig;
`,

  "src/app/layout.tsx": `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Acme Dashboard",
  description: "Internal dashboard for Acme Corp",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,

  "src/app/globals.css": `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #111;
  background: #fafafa;
}

a {
  color: #0070f3;
  text-decoration: none;
}
`,

  "src/app/page.tsx": `import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <>
      <Header />
      <main style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
        <h1>Welcome to Acme Dashboard</h1>
        <p>Select a section from the navigation above.</p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "2rem" }}>
          <div style={{ padding: "1.5rem", border: "1px solid #eee", borderRadius: "8px" }}>
            <h2>Users</h2>
            <p>12,847 active users</p>
          </div>
          <div style={{ padding: "1.5rem", border: "1px solid #eee", borderRadius: "8px" }}>
            <h2>Revenue</h2>
            <p>$1.2M this quarter</p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
`,

  "src/app/about/page.tsx": `import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export default function About() {
  return (
    <>
      <Header />
      <main style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
        <h1>About Acme Dashboard</h1>
        <p>
          This is the internal dashboard for Acme Corp. It provides real-time
          analytics, user management, and reporting tools for the team.
        </p>
        <p style={{ marginTop: "1rem" }}>
          Built with Next.js and deployed on Vercel.
        </p>
      </main>
      <Footer />
    </>
  );
}
`,

  "src/components/header.tsx": `import Link from "next/link";

export function Header() {
  return (
    <header style={{
      borderBottom: "1px solid #eee",
      padding: "1rem 2rem",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    }}>
      <Link href="/" style={{ fontWeight: 700, fontSize: "1.2rem" }}>
        Acme Dashboard
      </Link>
      <nav style={{ display: "flex", gap: "1.5rem" }}>
        <Link href="/">Home</Link>
        <Link href="/about">About</Link>
      </nav>
    </header>
  );
}
`,

  "src/components/footer.tsx": `export function Footer() {
  return (
    <footer style={{
      borderTop: "1px solid #eee",
      padding: "1rem 2rem",
      textAlign: "center",
      color: "#666",
      fontSize: "0.875rem",
      marginTop: "4rem",
    }}>
      &copy; 2025 Acme Corp. All rights reserved.
    </footer>
  );
}
`,

  "src/lib/utils.ts": `export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function classNames(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
`,
};
