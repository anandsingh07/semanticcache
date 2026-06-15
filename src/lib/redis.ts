import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";
import { logger } from "./logger.js";

let client: Redis | null = null;

/**
 * Shared ioredis connection. Lazily created so importing this module in tests that
 * don't touch Redis doesn't open a socket.
 */
export function getRedis(): Redis {
  if (client) return client;
  const env = loadEnv();
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on("error", (err) => logger.error({ err }, "redis error"));
  client.on("connect", () => logger.debug("redis connected"));
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
