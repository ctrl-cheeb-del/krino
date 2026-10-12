/**
 * Signed access tokens. Hand an agent a token for one folder; it can't reach
 * any other folder, can be read-only, and can expire. Signed with
 * HMAC-SHA256 through Web Crypto, so it works in Workers, Node and Bun.
 */
export interface TokenClaims {
  /** The folder this token opens, e.g. a project or customer id. */
  folder: string;
  /** Who is using it; each agent gets its own `cd` and `export`. Default `default`. */
  agent?: string;
  /** Writes fail with "read-only file system". */
  readOnly?: boolean;
  /** Expiry as a Unix time in seconds. */
  expiresAt?: number;
}

export interface CreateTokenOptions extends Omit<TokenClaims, "expiresAt"> {
  /** Seconds until the token stops working. Default: never. */
  expiresIn?: number;
}

const enc = new TextEncoder();

export async function createToken(secret: string, options: CreateTokenOptions): Promise<string> {
  if (!options.folder) throw new Error("createToken: folder is required");
  const { expiresIn, ...claims } = options;
  const body: TokenClaims = {
    ...claims,
    ...(expiresIn !== undefined && { expiresAt: Math.floor(Date.now() / 1000) + expiresIn }),
  };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** The token's claims, or null if it's forged, malformed or expired. */
export async function verifyToken(secret: string, token: string): Promise<Required<Omit<TokenClaims, "expiresAt">> & Pick<TokenClaims, "expiresAt"> | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromB64url(sig);
  } catch {
    return null;
  }
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await key(secret), sigBytes, enc.encode(payload));
  if (!ok) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (typeof claims.folder !== "string" || !claims.folder) return null;
  if (claims.expiresAt !== undefined && claims.expiresAt <= Date.now() / 1000) return null;
  return {
    folder: claims.folder,
    agent: claims.agent || "default",
    readOnly: claims.readOnly === true,
    expiresAt: claims.expiresAt,
  };
}

/** Reads `Authorization: Bearer <token>` and verifies it. */
export async function authorize(secret: string, request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? verifyToken(secret, match[1]!) : null;
}

const keys = new Map<string, Promise<CryptoKey>>();
function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 16) throw new Error("krino auth: use a secret of at least 16 characters");
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keys.set(secret, k);
  }
  return k;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
