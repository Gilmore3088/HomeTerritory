// Gate C: advisory LLM review of generated questions.
//   node --experimental-strip-types etl/gate-c.ts [batch-size]
//
// Pulls active generated questions that have never been reviewed, asks
// Claude to check each one for ambiguity, answer leaks, multiple defensible
// answers and distractor problems, and:
//   * stamps questions.gate_c_reviewed_at on every reviewed row
//   * files facts.fact_conflicts (kind 'gate_c_flag') for each finding
// Advisory means advisory: nothing is retired here. A human reads the
// flags (the /review surface, P3c-2) and decides. Requires ANTHROPIC_API_KEY
// in addition to the usual ETL env; exits 0 with a notice when absent so
// the nightly pipeline can run without the key configured.
import { factsClient, publicClient, readEnv } from "./lib/db.ts";

const MODEL = process.env.GATE_C_MODEL ?? "claude-haiku-4-5-20251001";
const PER_REQUEST = 5;

interface QuestionRow {
  id: string;
  question_text: string;
  format: string;
  options: string[];
  correct_answer: string;
  aliases: string[];
  territory_id: string;
  sport: string;
}

interface Verdict {
  id: string;
  ok: boolean;
  issues: string[];
}

export function buildPrompt(batch: QuestionRow[]): string {
  const items = batch.map((q) => ({
    id: q.id,
    question: q.question_text,
    format: q.format,
    options: q.format === "multiple_choice" ? q.options : undefined,
    correct_answer: q.correct_answer,
    accepted_aliases: q.aliases,
  }));
  return [
    "You are reviewing machine-generated sports trivia questions before they reach players.",
    "For each question, check:",
    "1. Exactly one defensible correct answer (for multiple choice: no other option is also true).",
    "2. The question text does not contain or strongly hint at the answer.",
    "3. The phrasing is unambiguous and grammatical.",
    "4. The stated correct answer is factually plausible for the question as asked.",
    'Reply with ONLY a JSON array, one object per question: {"id": "...", "ok": true|false, "issues": ["..."]}.',
    "Flag ok=false only for real problems a player would notice; style nitpicks are not issues.",
    "",
    JSON.stringify(items, null, 2),
  ].join("\n");
}

export function parseVerdicts(text: string, expectedIds: string[]): Verdict[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("reviewer reply contained no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Verdict[];
  const known = new Set(expectedIds);
  return parsed.filter((v) => known.has(v.id)).map((v) => ({
    id: v.id,
    ok: v.ok === true,
    issues: Array.isArray(v.issues) ? v.issues.map(String).slice(0, 5) : [],
  }));
}

async function review(batch: QuestionRow[], apiKey: string): Promise<Verdict[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: buildPrompt(batch) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { content: Array<{ type: string; text?: string }> };
  const text = body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  return parseVerdicts(text, batch.map((q) => q.id));
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    console.log("gate-c: ANTHROPIC_API_KEY not set; skipping advisory review.");
    return;
  }
  const env = readEnv();
  const pub = publicClient(env);
  const facts = factsClient(env);
  const batchSize = Math.min(200, Number(process.argv[2] ?? 40));

  const pulled = await pub
    .from("questions")
    .select("id, question_text, format, options, correct_answer, aliases, territory_id, sport")
    .eq("active", true)
    .eq("validation_status", "generated_v1")
    .is("gate_c_reviewed_at", null)
    .limit(batchSize);
  if (pulled.error) throw new Error(`pulling questions failed: ${pulled.error.message}`);
  const rows = (pulled.data ?? []) as QuestionRow[];
  if (rows.length === 0) {
    console.log("gate-c: nothing awaiting review.");
    return;
  }

  let flagged = 0;
  for (let i = 0; i < rows.length; i += PER_REQUEST) {
    const batch = rows.slice(i, i + PER_REQUEST);
    const verdicts = await review(batch, apiKey);
    for (const v of verdicts) {
      if (!v.ok) {
        flagged += 1;
        const filed = await facts.from("fact_conflicts").insert({
          entity_type: "question",
          entity_id: v.id,
          field: "gate_c",
          kind: "gate_c_flag",
          detail: { issues: v.issues, model: MODEL, question_id: v.id },
        });
        if (filed.error) throw new Error(`filing gate_c_flag failed: ${filed.error.message}`);
      }
    }
    const stamped = await pub
      .from("questions")
      .update({ gate_c_reviewed_at: new Date().toISOString() })
      .in("id", batch.map((q) => q.id));
    if (stamped.error) throw new Error(`stamping review failed: ${stamped.error.message}`);
  }
  console.log(`gate-c: reviewed ${rows.length}, flagged ${flagged}.`);
}

if (process.argv[1]?.endsWith("gate-c.ts")) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
