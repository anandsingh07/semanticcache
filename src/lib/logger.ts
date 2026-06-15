import pino from "pino";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty output in dev only; JSON in prod for log aggregation.
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  // Never leak the API key if a config object is ever logged.
  redact: {
    paths: ["GEMINI_API_KEY", "*.GEMINI_API_KEY", "headers.authorization", 'headers["x-api-key"]'],
    censor: "[redacted]",
  },
});

export default logger;
