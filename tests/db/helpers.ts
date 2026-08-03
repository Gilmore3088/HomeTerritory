import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Default matches this repo's documented local stack (docs/superpowers/local-stack.md),
// which shifts every Supabase CLI port up by 1000 to avoid colliding with another
// project's stack on the same host. Override with SUPABASE_TEST_URL if your stack
// uses the CLI's stock defaults (54321) instead.
const url = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_KEY ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";

if (!serviceKey || !anonKey) {
  throw new Error("Set SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_KEY (see docs/superpowers/local-stack.md).");
}

export const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export async function createTestUser(displayName: string): Promise<SupabaseClient> {
  const email = `${crypto.randomUUID()}@playtest.local`;
  const password = "playtest-password-1";
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (created.error) throw created.error;
  const user = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await user.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return user;
}

export async function correctAnswerFor(sessionId: string): Promise<string> {
  const { data, error } = await admin
    .from("question_attempts")
    .select("questions(correct_answer)")
    .eq("session_id", sessionId)
    .is("answered_at", null)
    .order("served_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return (data as unknown as { questions: { correct_answer: string } }).questions.correct_answer;
}

export async function answerUntilResolved(
  user: SupabaseClient,
  sessionId: string,
): Promise<{ status: string; message?: string }> {
  for (let round = 0; round < 5; round += 1) {
    const answer = await correctAnswerFor(sessionId);
    const { data, error } = await user.rpc("game_submit_answer", {
      p_session_id: sessionId,
      p_answer: answer,
    });
    if (error) throw error;
    const result = data as { status: string; message?: string };
    if (result.status !== "active") return result;
  }
  throw new Error("Session did not resolve within five correct answers.");
}
