// Vitest setup for unit tests: provide the minimal env that modules expect when imported,
// so unit tests need no external services and CI can run `npm run test` with no extra env.
// Integration tests set their own env (real container URLs) before importing app modules.

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:5432/db";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.GEMINI_API_KEY ??= "test-key";
process.env.LOG_LEVEL ??= "fatal";
