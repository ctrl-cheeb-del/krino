/**
 * A realistic SaaS boilerplate — Next.js + Tailwind + Convex.
 * Landing page with pricing, dashboard, settings, API layer.
 */
export const SAAS_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "launchpad-saas",
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
      convex: "^1.17.0",
      "lucide-react": "^0.400.0",
      "class-variance-authority": "^0.7.0",
      clsx: "^2.1.0",
    },
    devDependencies: {
      "@types/node": "^20",
      "@types/react": "^18",
      typescript: "^5",
      tailwindcss: "^3.4.0",
      autoprefixer: "^10",
      postcss: "^8",
    },
  }, null, 2),

  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "es2017",
      lib: ["dom", "es2017"],
      jsx: "preserve",
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["**/*.ts", "**/*.tsx"],
  }, null, 2),

  "next.config.js": `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};
module.exports = nextConfig;
`,

  "tailwind.config.ts": `import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f5ff",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
    },
  },
  plugins: [],
};
export default config;
`,

  "convex/schema.ts": `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  projects: defineTable({
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("archived")),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    key: v.string(),
    name: v.string(),
    lastUsed: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});
`,

  "convex/users.ts": `import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getUser = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

export const createUser = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const updatePlan = mutation({
  args: {
    userId: v.id("users"),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { plan: args.plan });
  },
});
`,

  "convex/projects.ts": `import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listProjects = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const createProject = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("projects", {
      ...args,
      status: "active",
      createdAt: Date.now(),
    });
  },
});
`,

  "src/app/layout.tsx": `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Launchpad — Ship faster",
  description: "The modern SaaS boilerplate for Next.js",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
`,

  "src/app/globals.css": `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
`,

  "src/app/page.tsx": `import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <Hero />
      <Features />
      <Pricing />
      <Footer />
    </div>
  );
}
`,

  "src/components/landing/navbar.tsx": `import Link from "next/link";

export function Navbar() {
  return (
    <nav className="border-b bg-white">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/" className="font-bold text-xl">
          🚀 Launchpad
        </Link>
        <div className="flex items-center gap-6">
          <Link href="#features" className="text-gray-600 hover:text-gray-900">Features</Link>
          <Link href="#pricing" className="text-gray-600 hover:text-gray-900">Pricing</Link>
          <Link href="/login" className="text-gray-600 hover:text-gray-900">Log in</Link>
          <Link href="/signup" className="bg-brand-600 text-white px-4 py-2 rounded-lg hover:bg-brand-700">
            Get Started
          </Link>
        </div>
      </div>
    </nav>
  );
}
`,

  "src/components/landing/hero.tsx": `export function Hero() {
  return (
    <section className="py-20 text-center">
      <div className="max-w-3xl mx-auto px-4">
        <h1 className="text-5xl font-bold tracking-tight text-gray-900">
          Ship your SaaS in days,<br />not months
        </h1>
        <p className="mt-6 text-xl text-gray-600">
          Launchpad gives you authentication, payments, dashboards, and
          everything else you need. Stop rebuilding boilerplate.
        </p>
        <div className="mt-10 flex justify-center gap-4">
          <a href="/signup" className="bg-brand-600 text-white px-8 py-3 rounded-lg text-lg hover:bg-brand-700">
            Start Building
          </a>
          <a href="#features" className="border border-gray-300 px-8 py-3 rounded-lg text-lg hover:bg-gray-50">
            See Features
          </a>
        </div>
      </div>
    </section>
  );
}
`,

  "src/components/landing/features.tsx": `const FEATURES = [
  {
    title: "Authentication",
    description: "Email/password, OAuth, and magic links out of the box.",
    icon: "🔐",
  },
  {
    title: "Payments",
    description: "Stripe integration with subscriptions, invoices, and webhooks.",
    icon: "💳",
  },
  {
    title: "Dashboard",
    description: "Beautiful admin dashboard with charts, tables, and analytics.",
    icon: "📊",
  },
  {
    title: "API Layer",
    description: "Type-safe API with Convex. Real-time sync built in.",
    icon: "⚡",
  },
  {
    title: "Email",
    description: "Transactional email with Resend. Templates included.",
    icon: "📧",
  },
  {
    title: "Deploy",
    description: "One-click deploy to Vercel. CI/CD pipeline ready.",
    icon: "🚢",
  },
];

export function Features() {
  return (
    <section id="features" className="py-20 bg-gray-50">
      <div className="max-w-6xl mx-auto px-4">
        <h2 className="text-3xl font-bold text-center">Everything you need</h2>
        <p className="mt-4 text-center text-gray-600 max-w-2xl mx-auto">
          Stop wasting time on boilerplate. Launchpad includes all the features
          you need to launch your SaaS product.
        </p>
        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="bg-white p-6 rounded-xl shadow-sm border">
              <div className="text-3xl">{feature.icon}</div>
              <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-gray-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
`,

  "src/components/landing/pricing.tsx": `const PLANS = [
  {
    name: "Starter",
    price: "$0",
    period: "forever",
    description: "For side projects and experimentation.",
    features: [
      "1 project",
      "1,000 API calls/month",
      "Community support",
      "Basic analytics",
    ],
    cta: "Get Started Free",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$29",
    period: "/month",
    description: "For growing startups and indie hackers.",
    features: [
      "Unlimited projects",
      "100,000 API calls/month",
      "Priority support",
      "Advanced analytics",
      "Custom domain",
      "Team members (up to 5)",
    ],
    cta: "Start Pro Trial",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "$99",
    period: "/month",
    description: "For teams that need more power and control.",
    features: [
      "Unlimited everything",
      "Unlimited API calls",
      "Dedicated support",
      "SSO & SAML",
      "Custom contracts",
      "SLA guarantee",
      "Audit logs",
    ],
    cta: "Contact Sales",
    highlighted: false,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="py-20">
      <div className="max-w-6xl mx-auto px-4">
        <h2 className="text-3xl font-bold text-center">Simple, transparent pricing</h2>
        <p className="mt-4 text-center text-gray-600">
          No hidden fees. No surprises. Cancel anytime.
        </p>
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={\`p-8 rounded-xl border \${
                plan.highlighted
                  ? "border-brand-500 shadow-lg ring-2 ring-brand-500"
                  : "border-gray-200"
              }\`}
            >
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-2 text-gray-600">{plan.description}</p>
              <div className="mt-6">
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className="text-gray-500">{plan.period}</span>
              </div>
              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <span className="text-green-500">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                className={\`mt-8 w-full py-3 rounded-lg font-medium \${
                  plan.highlighted
                    ? "bg-brand-600 text-white hover:bg-brand-700"
                    : "border border-gray-300 hover:bg-gray-50"
                }\`}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
`,

  "src/components/landing/footer.tsx": `export function Footer() {
  return (
    <footer className="border-t py-12">
      <div className="max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-gray-600">
              <li><a href="#features">Features</a></li>
              <li><a href="#pricing">Pricing</a></li>
              <li><a href="/changelog">Changelog</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-gray-600">
              <li><a href="/about">About</a></li>
              <li><a href="/blog">Blog</a></li>
              <li><a href="/careers">Careers</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-gray-600">
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Connect</h4>
            <ul className="space-y-2 text-gray-600">
              <li><a href="https://twitter.com">Twitter</a></li>
              <li><a href="https://github.com">GitHub</a></li>
              <li><a href="https://discord.gg">Discord</a></li>
            </ul>
          </div>
        </div>
        <div className="mt-8 pt-8 border-t text-center text-gray-500 text-sm">
          © 2025 Launchpad. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
`,

  "src/app/dashboard/layout.tsx": `import { Sidebar } from "@/components/dashboard/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 bg-gray-50">{children}</main>
    </div>
  );
}
`,

  "src/app/dashboard/page.tsx": `export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-2 text-gray-600">Welcome back! Here's what's happening.</p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border">
          <p className="text-sm text-gray-500">Total Users</p>
          <p className="text-3xl font-bold mt-1">2,847</p>
          <p className="text-sm text-green-600 mt-2">+12% from last month</p>
        </div>
        <div className="bg-white p-6 rounded-xl border">
          <p className="text-sm text-gray-500">Revenue</p>
          <p className="text-3xl font-bold mt-1">$48,290</p>
          <p className="text-sm text-green-600 mt-2">+8% from last month</p>
        </div>
        <div className="bg-white p-6 rounded-xl border">
          <p className="text-sm text-gray-500">Active Projects</p>
          <p className="text-3xl font-bold mt-1">384</p>
          <p className="text-sm text-red-600 mt-2">-3% from last month</p>
        </div>
      </div>
    </div>
  );
}
`,

  "src/app/dashboard/settings/page.tsx": `export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-2 text-gray-600">Manage your account settings.</p>
      {/* TODO: Add settings form */}
    </div>
  );
}
`,

  "src/components/dashboard/sidebar.tsx": `import Link from "next/link";

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: "📊" },
  { label: "Projects", href: "/dashboard/projects", icon: "📁" },
  { label: "Analytics", href: "/dashboard/analytics", icon: "📈" },
  { label: "Settings", href: "/dashboard/settings", icon: "⚙️" },
];

export function Sidebar() {
  return (
    <aside className="w-64 border-r bg-white p-6">
      <div className="font-bold text-lg mb-8">🚀 Launchpad</div>
      <nav className="space-y-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
          >
            <span>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
`,

  "src/lib/utils.ts": `import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
`,
};
