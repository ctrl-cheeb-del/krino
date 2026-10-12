// bun token.ts <folder> [agent] [--read-only] [--expires-in=3600]
import { createToken } from "krino";

const secret = process.env.KRINO_SECRET;
if (!secret) throw new Error("set KRINO_SECRET (the same value as the Worker's secret)");
const args = process.argv.slice(2);
const [folder, agent] = args.filter((a) => !a.startsWith("--"));
if (!folder) throw new Error("usage: bun token.ts <folder> [agent] [--read-only] [--expires-in=seconds]");
const expires = args.find((a) => a.startsWith("--expires-in="))?.split("=")[1];
console.log(
  await createToken(secret, {
    folder,
    agent,
    readOnly: args.includes("--read-only"),
    expiresIn: expires ? Number(expires) : undefined,
  }),
);
