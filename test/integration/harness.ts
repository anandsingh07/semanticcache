import { execSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

// Shared Testcontainers harness for integration tests. Starts real Postgres (pgvector) +
// Redis, applies migrations, sets env, and dynamically imports the app modules AFTER env is
// configured so loadEnv() picks up the container URLs. Returns handles + a teardown.

export interface Harness {
  pg: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  // Loaded lazily after env is set.
  CacheCore: typeof import("../../src/cache/core.js").CacheCore;
  prisma: typeof import("../../src/db/index.js").prisma;
  closeRedis: typeof import("../../src/lib/redis.js").closeRedis;
  vector: typeof import("../../src/db/vector.js");
  teardown: () => Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("semcache")
    .withUsername("semcache")
    .withPassword("semcache")
    .start();
  const redis = await new RedisContainer("redis:7-alpine").start();

  const databaseUrl = pg.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redis.getConnectionUrl();
  process.env.NODE_ENV = "test";
  process.env.GEMINI_API_KEY = "mock";
  process.env.LOG_LEVEL = "fatal";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
  });

  const { CacheCore } = await import("../../src/cache/core.js");
  const { prisma } = await import("../../src/db/index.js");
  const { closeRedis } = await import("../../src/lib/redis.js");
  const vector = await import("../../src/db/vector.js");

  const teardown = async () => {
    await prisma.$disconnect();
    await closeRedis();
    await redis.stop();
    await pg.stop();
  };

  return { pg, redis, CacheCore, prisma, closeRedis, vector, teardown };
}

/** Make a control object with defaults (read on, store on, given namespace). */
export function control(
  namespace = "test",
  overrides: Partial<{ bypassRead: boolean; noStore: boolean; threshold: number | null }> = {},
) {
  return {
    bypassRead: overrides.bypassRead ?? false,
    noStore: overrides.noStore ?? false,
    namespace,
    threshold: overrides.threshold ?? null,
  };
}
