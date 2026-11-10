// Central configuration: loads .env (without overriding real env vars) and validates it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv(path.join(ROOT, '.env'));
// Railway templates and linked Postgres services use different variable names.
// Normalize them once so the rest of the application has one canonical DSN.
if (!process.env.DATABASE_URL) {
  for (const key of ['DATABASE_PRIVATE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'DATABASE_PUBLIC_URL']) {
    if (process.env[key]) { process.env.DATABASE_URL = process.env[key]; break; }
  }
}

const bool = (d) => z.preprocess((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z.enum(['auto', 'true', 'false']).default('auto'),
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  MASTER_KEY: z.string().min(32, 'MASTER_KEY must be at least 32 chars (use: openssl rand -base64 32)'),
  MASTER_KEY_OLD: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warning', 'error', 'critical']).default('info'),
  SERVE_STATIC: bool(true),
  AUTO_MIGRATE: bool(true),
  EMBED_WORKER: bool(false),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  ALLOWED_ORIGINS: z.string().optional(),
  WORKER_ONLY: z.string().optional(), // comma list of worker module names to start
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n[NABD AI] Invalid configuration:\n${msg}\nSee .env.example\n`);
  process.exit(1);
}
export const config = Object.freeze({
  ...parsed.data,
  DATA_DIR: path.resolve(ROOT, parsed.data.DATA_DIR),
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});
for (const d of ['', 'backups', 'logs', 'exports']) fs.mkdirSync(path.join(config.DATA_DIR, d), { recursive: true });
