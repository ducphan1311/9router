#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_VAULT_ADDR = "http://127.0.0.1:8200";
const DEFAULT_SECRET_PATH = "/v1/openclaw_secrets/data/9router";

const REQUIRED_KEYS = [
  "JWT_SECRET",
  "INITIAL_PASSWORD",
  "API_KEY_SECRET",
  "MACHINE_ID_SALT",
];

const OPTIONAL_DEFAULTS = {
  DATA_DIR: ".data",
  PORT: "20128",
  NODE_ENV: "development",
  ENABLE_REQUEST_LOGS: "false",
  OBSERVABILITY_ENABLED: "true",
  AUTH_COOKIE_SECURE: "false",
  REQUIRE_API_KEY: "false",
  BASE_URL: "http://localhost:20128",
  CLOUD_URL: "https://9router.com",
  NEXT_PUBLIC_BASE_URL: "http://localhost:20128",
  NEXT_PUBLIC_CLOUD_URL: "https://9router.com",
  NO_PROXY: "localhost,127.0.0.1",
};

async function readVaultToken() {
  if (process.env.VAULT_TOKEN) return process.env.VAULT_TOKEN.trim();

  const tokenPath = join(homedir(), ".vault-token");
  if (existsSync(tokenPath)) {
    return (await readFile(tokenPath, "utf8")).trim();
  }

  throw new Error("Missing VAULT_TOKEN and no ~/.vault-token file found.");
}

async function loadVaultSecret() {
  const vaultAddr = (process.env.VAULT_ADDR || DEFAULT_VAULT_ADDR).replace(/\/$/, "");
  const secretPath = process.env.VAULT_SECRET_PATH || DEFAULT_SECRET_PATH;
  const token = await readVaultToken();

  const response = await fetch(`${vaultAddr}${secretPath}`, {
    headers: { "X-Vault-Token": token },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vault read failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const secret = payload?.data?.data;

  if (!secret || typeof secret !== "object") {
    throw new Error("Vault response did not contain KV v2 data at data.data.");
  }

  return secret;
}

function resolveNodeEnv(command, args) {
  if (command === "next" && args[0] === "dev") return "development";
  if (command === "next" && ["build", "start"].includes(args[0])) return "production";
  return undefined;
}

function buildEnv(secret, command, args) {
  const missing = REQUIRED_KEYS.filter((key) => !secret[key]);
  if (missing.length > 0) {
    throw new Error(`Vault secret is missing required keys: ${missing.join(", ")}`);
  }

  const env = { ...process.env, ...OPTIONAL_DEFAULTS };

  for (const [key, value] of Object.entries(secret)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }

  const nodeEnv = resolveNodeEnv(command, args);
  if (nodeEnv) env.NODE_ENV = nodeEnv;

  return env;
}

function run(command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/vault-env.mjs <command> [...args]");
  process.exit(1);
}

try {
  const secret = await loadVaultSecret();
  const env = buildEnv(secret, command, args);
  run(command, args, env);
} catch (error) {
  console.error(`[vault-env] ${error.message}`);
  process.exit(1);
}
