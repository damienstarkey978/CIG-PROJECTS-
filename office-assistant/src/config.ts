import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: () => required("DATABASE_URL"),
  encryptionKey: () => required("APP_ENCRYPTION_KEY"),
  publicBaseUrl: () => required("PUBLIC_BASE_URL"),
  quoApiBase: process.env.QUO_API_BASE ?? "https://api.openphone.com/v1",
  classifierModel: process.env.CLASSIFIER_MODEL ?? "claude-opus-5-5",
  classifierEffort: (process.env.CLASSIFIER_EFFORT ?? "low") as "low" | "medium" | "high",
  // How long to wait for Quo's transcript/summary before processing a call with what we have.
  transcriptWaitMs: Number(process.env.TRANSCRIPT_WAIT_MS ?? 15 * 60_000),
  // First look at a call after call.completed, giving transcripts a head start.
  firstLookDelayMs: Number(process.env.FIRST_LOOK_DELAY_MS ?? 3 * 60_000),
  workerPollMs: Number(process.env.WORKER_POLL_MS ?? 2_000),
};
