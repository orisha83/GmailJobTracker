import { config } from "@/lib/config";
import type { EmailAnalyzer } from "./analyzer";
import { GeminiAnalyzer } from "./gemini";
import { ClaudeAnalyzer } from "./claude";

/** Picks the analyzer from AI_PROVIDER (claude default; gemini available). */
export function getAnalyzer(): EmailAnalyzer {
  return config.aiProvider === "gemini" ? new GeminiAnalyzer() : new ClaudeAnalyzer();
}
