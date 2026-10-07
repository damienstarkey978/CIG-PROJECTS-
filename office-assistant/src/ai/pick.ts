import { claudeClassifier, type Classifier } from "./classify";
import { claudeDrafter, offlineDrafter, type Drafter } from "../changeorders/draft";
import { claudeEmailParser, offlineEmailParser, type EmailParser } from "../updates/parse";
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

export function pickDrafter(): Drafter {
  return hasClaudeCredentials() ? claudeDrafter() : offlineDrafter();
}

export function pickEmailParser(): EmailParser {
  return hasClaudeCredentials() ? claudeEmailParser() : offlineEmailParser();
}
