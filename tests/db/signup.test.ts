// Probes for the `test-signup` edge function, which is the only path that
// creates accounts for a playtest league. It runs under the service key, so a
// mistake here is an account-takeover, not a validation nit.
//
// These call the function over HTTP against the local stack the same way the
// browser does (`supabase.functions.invoke` sends the anon key as the bearer).
//
// The local edge runtime caches the function module, so after editing
// `supabase/functions/test-signup/index.ts` run
// `docker restart supabase_edge_runtime_HomeTerritory` before trusting a run --
// `supabase db reset` does not restart it.
import assert from "node:assert/strict";
import test from "node:test";
import { admin, createTestUser, stackAnonKey, stackUrl } from "./helpers.ts";

const SIGNUP_URL = `${stackUrl}/functions/v1/test-signup`;

type SignupResponse = { status: number; body: { ok?: boolean; error?: string; message?: string } };

async function signup(body: Record<string, unknown>): Promise<SignupResponse> {
  const response = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${stackAnonKey}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Creates a playtest league and returns its invite code. */
async function playtestLeague(): Promise<string> {
  const commissioner = await createTestUser("Signup Commissioner");
  const created = await commissioner.rpc("create_group_v2", {
    p_name: `Signup ${crypto.randomUUID().slice(0, 8)}`,
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  if (created.error) throw created.error;
  const { data, error } = await admin.from("groups").select("invite_code").eq("id", created.data as string).single();
  if (error) throw error;
  return (data as { invite_code: string }).invite_code;
}

test("a valid invite code creates the account and joins the league", async () => {
  const inviteCode = await playtestLeague();
  const email = `${crypto.randomUUID()}@playtest.local`;

  const { status, body } = await signup({
    displayName: "Fresh Player",
    email,
    password: "playtest-password-1",
    inviteCode,
  });
  assert.equal(status, 200, body.error ?? "signup failed");
  assert.equal(body.ok, true);

  const { data: profiles } = await admin.from("profiles").select("display_name").eq("display_name", "Fresh Player");
  assert.ok((profiles ?? []).length >= 1, "the signup should have written a profile");
});

test("an invite code that is not an active playtest league is refused before any account is created", async () => {
  const email = `${crypto.randomUUID()}@playtest.local`;
  const { status, body } = await signup({
    displayName: "Blocked Player",
    email,
    password: "playtest-password-1",
    inviteCode: "ZZZZZZZZ",
  });
  assert.equal(status, 403);
  assert.match(body.error ?? "", /not an active playtest invite/i);

  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  assert.equal(
    (data?.users ?? []).some((candidate) => candidate.email?.toLowerCase() === email),
    false,
    "no account may be created before the invite code is verified",
  );
});

// Finding 14: when the submitted email matched an existing *unconfirmed* account
// the function called `admin.auth.admin.updateUserById` to set the caller's
// password and `email_confirm: true`, so anyone holding a valid playtest invite
// code could seize any unconfirmed account just by knowing its address.
test("signup cannot take over an existing unconfirmed account", async () => {
  const inviteCode = await playtestLeague();
  const victimEmail = `${crypto.randomUUID()}@playtest.local`;
  const victimPassword = "victim-password-1";
  const attackerPassword = "attacker-password-1";

  const victim = await admin.auth.admin.createUser({
    email: victimEmail,
    password: victimPassword,
    email_confirm: false,
    user_metadata: { display_name: "Victim" },
  });
  assert.equal(victim.error, null);
  const victimId = victim.data.user!.id;

  const { status, body } = await signup({
    displayName: "Attacker",
    email: victimEmail,
    password: attackerPassword,
    inviteCode,
  });
  assert.notEqual(status, 200, `takeover attempt returned ${status}: ${JSON.stringify(body)}`);
  assert.notEqual(body.ok, true);

  const after = await admin.auth.admin.getUserById(victimId);
  assert.equal(after.error, null);
  assert.equal(after.data.user?.email_confirmed_at ?? null, null, "the victim's account must stay unconfirmed");
  assert.notEqual(
    after.data.user?.user_metadata?.display_name,
    "Attacker",
    "the attacker must not overwrite the victim's profile metadata",
  );
});
