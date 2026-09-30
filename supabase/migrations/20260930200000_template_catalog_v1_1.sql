-- Phase 3, P3b task 3 continued: catalog v1.1 -- four templates the v1
-- cut skipped, all backed by columns the ingesters already fill.
-- Conventions unchanged (see 20260930120000): compiler answer contract,
-- verified computed from the facts' confidence, comparative margins so
-- "which is X-est" always has one defensible answer, and comparators
-- restricted to verified rows so an unverified value can never make a
-- wrong option correct.

insert into facts.question_templates
  (slug, sport, link_type, format, tier_base, option_count, text_template, answer_sql, distractor_sql)
values

('championship-runnerup-mc', 'OTH', 'event', 'multiple_choice', 2, 4,
 'Who did the {winner} beat in {season}?',
 $sql$
   -- "in Super Bowl 50" but "in the 2004 World Series": the article
   -- belongs to the label, so it rides in the param.
   select ch.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('winner', ch.winner_name,
            'season', case when ch.season ~* '^super bowl' then ch.season else 'the ' || ch.season end,
            'league', ch.league) as params,
          ch.runner_up_name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = ch.runner_up_team_id), '{}') as aliases,
          coalesce(p.score, 0.45) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.championships','id',ch.id)) as fact_refs,
          (ch.confidence in ('gold','cross_verified') and ch.runner_up_name is not null) as verified
   from facts.championships ch
   join facts.teams tm on tm.id = ch.winner_team_id
   left join facts.prominence p on p.entity_type = 'championship' and p.entity_id = ch.id
   where tm.state is not null and ch.runner_up_name is not null
 $sql$,
 $sql$
   -- Same-league teams; the compiler lint drops the runner-up itself and
   -- the winner never appears because it is in the question text.
   select candidate from (
     select distinct t.name as candidate
     from facts.teams t
     where t.league = ($1->>'league') and t.name <> ($1->>'winner')
   ) pool order by random()
 $sql$),

('championship-mvp-ff', 'OTH', 'player', 'free_fill', 3, 2,
 'Who was named MVP of {season}?',
 $sql$
   select ch.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('season',
            case when ch.season ~* '^super bowl' then ch.season else 'the ' || ch.season end) as params,
          ch.mvp_name as answer,
          case when ch.mvp_name ~ '^\S+\s+\S+'
                and split_part(ch.mvp_name, ' ', -1) !~ '^(Jr|Sr|II|III|IV)\.?$'
               then array[split_part(ch.mvp_name, ' ', -1)]
               else '{}'::text[] end as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.championships','id',ch.id)) as fact_refs,
          (ch.confidence in ('gold','cross_verified') and ch.mvp_name is not null) as verified
   from facts.championships ch
   join facts.teams tm on tm.id = ch.winner_team_id
   left join facts.prominence p on p.entity_type = 'championship' and p.entity_id = ch.id
   where tm.state is not null and ch.mvp_name is not null
 $sql$,
 null),

('venue-elevation-compare-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'Which of these {league} venues sits at the highest elevation?',
 $sql$
   -- 200m margin: Denver-class answers only, never two mile-high options.
   select v.id as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'elev', v.elevation_m::text) as params,
          v.name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'venue' and al.entity_id = v.id), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and v.elevation_m is not null
     and 3 <= (select count(*) from facts.venues o
               cross join lateral jsonb_array_elements(o.tenants) as ot
               where ot->>'league' = tenant->>'league'
                 and o.id <> v.id and o.elevation_m is not null
                 and o.confidence in ('gold','cross_verified')
                 and o.elevation_m <= v.elevation_m - 200)
 $sql$,
 $sql$
   select o.name as candidate
   from facts.venues o
   cross join lateral jsonb_array_elements(o.tenants) as ot
   where ot->>'league' = ($1->>'league')
     and o.elevation_m is not null
     and o.confidence in ('gold','cross_verified')
     and o.elevation_m <= ($1->>'elev')::numeric - 200
   order by random()
 $sql$),

('venue-northernmost-compare-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'Which of these {league} venues is the farthest north?',
 $sql$
   -- 1.5 degrees of latitude (~165km): no coin-flip geography.
   select v.id as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'lat', v.latitude::text) as params,
          v.name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'venue' and al.entity_id = v.id), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and v.latitude is not null
     and 3 <= (select count(*) from facts.venues o
               cross join lateral jsonb_array_elements(o.tenants) as ot
               where ot->>'league' = tenant->>'league'
                 and o.id <> v.id and o.latitude is not null
                 and o.confidence in ('gold','cross_verified')
                 and o.latitude <= v.latitude - 1.5)
 $sql$,
 $sql$
   select o.name as candidate
   from facts.venues o
   cross join lateral jsonb_array_elements(o.tenants) as ot
   where ot->>'league' = ($1->>'league')
     and o.latitude is not null
     and o.confidence in ('gold','cross_verified')
     and o.latitude <= ($1->>'lat')::numeric - 1.5
   order by random()
 $sql$);

-- The v1 championship templates carry the same article bug ("Who won the
-- Super Bowl XXXVI?"); give them the same smart-article season param.
-- String surgery on templates-as-data is deliberate: the templates ARE
-- rows, and the compiled questions refresh on the next compile.
update facts.question_templates
set text_template = replace(text_template, 'the {season}', '{season}'),
    answer_sql = replace(answer_sql,
      $$'season', ch.season$$,
      $$'season', case when ch.season ~* '^super bowl' then ch.season else 'the ' || ch.season end$$)
where slug in ('championship-winner-mc', 'championship-winner-ff', 'championship-year-mc');
