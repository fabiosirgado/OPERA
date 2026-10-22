// Ajudas para os testes de RLS: correm contra o projeto Supabase de TESTES, como utilizadores reais,
// só com a chave publicável. As credenciais de teste ficam em .env.test, que nunca vai para o git.
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../../.env.test", import.meta.url));

export function loadEnv() {
  if (!existsSync(ENV_FILE)) return null;
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.VITE_SUPABASE_URL.includes("zorfupxbkluiswmhoqnq")) {
    throw new Error("Os testes de RLS só podem correr contra o projeto de testes.");
  }
  return env;
}

export const USERS = {
  admin: "teste.admin@example.com",
  gestor: "teste.gestor@example.com",
  aAdmin: "teste.a.admin@example.com",
  aUser: "teste.a.user@example.com",
  bAdmin: "teste.b.admin@example.com",
};

export function anonClient(env) {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function signIn(env, email) {
  const sb = anonClient(env);
  const { error } = await sb.auth.signInWithPassword({ email, password: env.TEST_PASSWORD });
  if (error) throw new Error(`Login falhou para ${email}: ${error.message}`);
  return sb;
}

// Login com verificação em dois passos (TOTP). Na primeira vez regista o fator e guarda o segredo em .env.test.
export async function signInWithMfa(env, email, key) {
  const sb = await signIn(env, email);
  let secret = env[key];
  let factorId;
  const { data: factors } = await sb.auth.mfa.listFactors();
  const verified = factors.totp.find((f) => f.status === "verified");
  if (verified && secret) {
    factorId = verified.id;
  } else {
    for (const f of factors.all.filter((f) => f.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `teste-${Date.now()}` });
    if (error) throw error;
    factorId = data.id;
    secret = data.totp.secret;
    appendFileSync(ENV_FILE, `${key}=${secret}\n`);
    env[key] = secret;
  }
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: totp(secret) });
  if (error) throw new Error(`Verificação em dois passos falhou para ${email}: ${error.message}`);
  return sb;
}

function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
