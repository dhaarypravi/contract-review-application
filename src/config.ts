/**
 * Environment, read in one place. Model keys are read lazily so that the build,
 * the migration and most tests run without them.
 */
export type Provider = "gemini" | "openrouter";

interface ProviderDefaults {
  baseUrl: string;
  keyName: "GEMINI_API_KEY" | "OPENROUTER_API_KEY";
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  /** Whether the embeddings endpoint honours a requested width. */
  canRequestDimensions: boolean;
}

const PROVIDERS: Record<Provider, ProviderDefaults> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyName: "GEMINI_API_KEY",
    chatModel: "gemini-flash-lite-latest",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 1536, // 3072 natively; a truncated vector is still usable
    canRequestDimensions: true,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyName: "OPENROUTER_API_KEY",
    chatModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    embeddingModel: "nvidia/nemotron-3.5-embed-1b:free",
    embeddingDimensions: 2048,
    canRequestDimensions: false,
  },
};

function provider(): Provider {
  const value = process.env.LLM_PROVIDER || "gemini";
  if (value !== "gemini" && value !== "openrouter") {
    throw new Error(`LLM_PROVIDER must be "gemini" or "openrouter", got "${value}"`);
  }
  return value;
}

export function llmConfig() {
  const name = provider();
  const defaults = PROVIDERS[name];
  return {
    provider: name,
    baseUrl: (process.env.LLM_BASE_URL || defaults.baseUrl).replace(/\/$/, ""),
    keyName: defaults.keyName,
    apiKey: process.env[defaults.keyName] || "",
    chatModel: process.env.CHAT_MODEL || defaults.chatModel,
    embeddingModel: process.env.EMBEDDING_MODEL || defaults.embeddingModel,
    embeddingDimensions: embeddingDimensions(),
    canRequestDimensions: defaults.canRequestDimensions,
  };
}

/** Part of the database column type, so it must be a sane integer. */
export function embeddingDimensions(): number {
  const value = Number(process.env.EMBEDDING_DIMENSIONS || PROVIDERS[provider()].embeddingDimensions);
  if (!Number.isInteger(value) || value < 1 || value > 16_000) {
    throw new Error(`EMBEDDING_DIMENSIONS must be an integer from 1 to 16000, got "${value}"`);
  }
  return value;
}

export const databaseUrl = () =>
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/contract_review";
export const redisUrl = () => process.env.REDIS_URL || "redis://localhost:6380";
export const uploadDir = () => process.env.UPLOAD_DIR || "./data/uploads";
export const appUrl = () => process.env.APP_URL || "http://localhost:3000";


