import { claudeClassifier, type Classifier } from "./classify";
import { offlineClassifier } from "./offline";
import { log } from "../lib/log";

export function hasClaudeCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function pickClassifier(): { classify: Classifier; engine: "claude" | "offline" } {
  if (hasClaudeCredentials()) return { classify: claudeClassifier(), engine: "claude" };
  log.warn("No Anthropic credentials: using the offline demo classifier. Do not use with live callers.");
  return { classify: offlineClassifier(), engine: "offline" };
}
