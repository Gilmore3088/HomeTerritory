alter extension unaccent set schema extensions;
alter extension fuzzystrmatch set schema extensions;

create index if not exists activity_events_actor_id_idx on public.activity_events(actor_id);
create index if not exists activity_events_territory_id_idx on public.activity_events(territory_id);
create index if not exists attacks_attacker_id_idx on public.attacks(attacker_id);
create index if not exists attacks_defender_id_idx on public.attacks(defender_id);
create index if not exists bot_action_log_bot_id_idx on public.bot_action_log(bot_id);
create index if not exists bot_action_log_territory_id_idx on public.bot_action_log(territory_id);
create index if not exists duel_attempts_question_id_idx on public.duel_attempts(question_id);
create index if not exists duel_attempts_user_id_idx on public.duel_attempts(user_id);
create index if not exists duels_challenger_id_idx on public.duels(challenger_id);
create index if not exists duels_opponent_id_idx on public.duels(opponent_id);
create index if not exists duels_territory_id_idx on public.duels(territory_id);
create index if not exists duels_winner_id_idx on public.duels(winner_id);
create index if not exists game_sessions_attack_id_idx on public.game_sessions(attack_id);
create index if not exists game_sessions_user_id_idx on public.game_sessions(user_id);
create index if not exists league_recaps_group_id_idx on public.league_recaps(group_id);
create index if not exists push_subscriptions_group_id_idx on public.push_subscriptions(group_id);
create index if not exists question_attempts_question_id_idx on public.question_attempts(question_id);
create index if not exists question_attempts_user_id_idx on public.question_attempts(user_id);
create index if not exists question_reports_attempt_id_idx on public.question_reports(attempt_id);
create index if not exists question_reports_reported_by_idx on public.question_reports(reported_by);
create index if not exists season_territories_owner_id_idx on public.season_territories(owner_id);
create index if not exists seasons_current_turn_user_id_idx on public.seasons(current_turn_user_id);

alter policy "players read own push subscriptions"
on public.push_subscriptions
using (user_id = (select auth.uid()));

alter policy "players insert own push subscriptions"
on public.push_subscriptions
with check (
  user_id = (select auth.uid())
  and public.is_group_member(group_id, (select auth.uid()))
);

alter policy "players update own push subscriptions"
on public.push_subscriptions
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and public.is_group_member(group_id, (select auth.uid()))
);

alter policy "players delete own push subscriptions"
on public.push_subscriptions
using (user_id = (select auth.uid()));
