-- Phase 3, P3b-2: template catalog v1.
--
-- ~20 templates over the warehouse. Conventions:
--   * answer_sql columns per the compiler contract (see 20260930110000).
--   * family_entity anchors near-duplicate suppression: every template
--     that could reveal another template's answer about the same entity
--     uses THAT entity as its family anchor only when the questions are
--     genuinely the same knowledge in different clothes; otherwise
--     families stay distinct on purpose.
--   * Comparative templates enforce an unambiguity margin (capacity 15%,
--     opening year 5 years) so "which is biggest/oldest" always has
--     exactly one defensible answer.
--   * Verified follows Gate B: every answer_sql computes it from the
--     underlying facts' confidence; nothing else is trusted.
--   * Templates whose source tables are still empty (events) compile to
--     zero instances today and light up as data lands -- by design.

insert into facts.question_templates
  (slug, sport, link_type, format, tier_base, option_count, text_template, answer_sql, distractor_sql)
values

-- ------------------------------------------------------------- venues
('venue-tenant-mc', 'OTH', 'venue', 'multiple_choice', 1, 4,
 'Which {league} team plays its home games at {venue}?',
 $sql$
   -- Shared buildings (SoFi, MetLife, Crypto.com Arena) have two truthful
   -- answers in the same league; only single-tenant (venue, league) pairs
   -- compile, and the family carries the league so an NFL and an NBA
   -- question about one building stay distinct questions.
   select v.id || ':' || (tenant->>'league') as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'venue', v.name) as params,
          tenant->>'team_name' as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = tenant->>'team_id'), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and tenant->>'league' is not null
     and 1 = (select count(*) from jsonb_array_elements(v.tenants) t2
              where t2->>'league' = tenant->>'league')
 $sql$,
 $sql$
   -- Never offer a co-tenant of the asked venue as a "wrong" answer.
   select candidate from (
     select distinct t.name as candidate
     from facts.teams t
     where t.league = ($1->>'league')
       and not exists (
         select 1 from facts.venues v2
         cross join lateral jsonb_array_elements(v2.tenants) tt
         where v2.name = ($1->>'venue') and tt->>'team_name' = t.name)
   ) pool order by random()
 $sql$),

('venue-tenant-ff', 'OTH', 'venue', 'free_fill', 2, 2,
 'Name the {league} team that calls {venue} home.',
 $sql$
   -- Same single-tenant-per-league rule as venue-tenant-mc: a free-fill
   -- grader must never mark a truthful co-tenant answer wrong.
   select v.id || ':' || (tenant->>'league') as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'venue', v.name) as params,
          tenant->>'team_name' as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = tenant->>'team_id'), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and tenant->>'league' is not null
     and 1 = (select count(*) from jsonb_array_elements(v.tenants) t2
              where t2->>'league' = tenant->>'league')
 $sql$,
 null),

('team-venue-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'Where do the {team} play their home games?',
 $sql$
   select tm.id as family_entity,
          coalesce(v.state, tm.state) as territory_id,
          jsonb_build_object('team', tm.name, 'league', tm.league) as params,
          v.name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'venue' and al.entity_id = v.id), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id),
                            jsonb_build_object('table','facts.teams','id',tm.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified') and tm.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   join facts.teams tm on tm.id = tenant->>'team_id'
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where coalesce(v.state, tm.state) is not null
 $sql$,
 $sql$
   select candidate from (
     select distinct v2.name as candidate
     from facts.venues v2
     cross join lateral jsonb_array_elements(v2.tenants) as tenant2
     where tenant2->>'league' = ($1->>'league')
   ) pool order by random()
 $sql$),

('venue-city-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'In which city is {venue}?',
 $sql$
   select v.id as family_entity,
          v.state as territory_id,
          jsonb_build_object('venue', v.name, 'state', v.state) as params,
          v.city as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and v.city is not null
 $sql$,
 $sql$
   select candidate from (
     select v2.city as candidate
     from facts.venues v2
     where v2.city is not null and v2.state = ($1->>'state')
     union
     select tm.city from facts.teams tm
     where tm.city is not null and tm.state = ($1->>'state')
   ) cities order by random()
 $sql$),

('venue-capacity-compare-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'Which of these {league} venues seats the most fans?',
 $sql$
   select v.id as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'cap', v.capacity::text) as params,
          v.name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'venue' and al.entity_id = v.id), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and v.capacity is not null
     -- Comparators must be verified too: an unverified capacity could
     -- silently make a "wrong" option the true answer.
     and 3 <= (select count(*) from facts.venues o
               cross join lateral jsonb_array_elements(o.tenants) as ot
               where ot->>'league' = tenant->>'league'
                 and o.id <> v.id and o.capacity is not null
                 and o.confidence in ('gold','cross_verified')
                 and o.capacity::numeric <= v.capacity::numeric / 1.15)
 $sql$,
 $sql$
   select o.name as candidate
   from facts.venues o
   cross join lateral jsonb_array_elements(o.tenants) as ot
   where ot->>'league' = ($1->>'league')
     and o.capacity is not null
     and o.confidence in ('gold','cross_verified')
     and o.capacity::numeric <= ($1->>'cap')::numeric / 1.15
   order by random()
 $sql$),

('venue-oldest-compare-mc', 'OTH', 'venue', 'multiple_choice', 2, 4,
 'Which of these {league} venues opened first?',
 $sql$
   select v.id as family_entity,
          v.state as territory_id,
          jsonb_build_object('league', tenant->>'league', 'opened', v.opened::text) as params,
          v.name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'venue' and al.entity_id = v.id), '{}') as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.venues','id',v.id)) as fact_refs,
          (v.confidence in ('gold','cross_verified')) as verified
   from facts.venues v
   cross join lateral jsonb_array_elements(v.tenants) as tenant
   left join facts.prominence p on p.entity_type = 'venue' and p.entity_id = v.id
   where v.state is not null and v.opened is not null
     -- Same rule as the capacity compare: only verified comparators.
     and 3 <= (select count(*) from facts.venues o
               cross join lateral jsonb_array_elements(o.tenants) as ot
               where ot->>'league' = tenant->>'league'
                 and o.id <> v.id and o.opened is not null
                 and o.confidence in ('gold','cross_verified')
                 and o.opened >= v.opened + 5)
 $sql$,
 $sql$
   select o.name as candidate
   from facts.venues o
   cross join lateral jsonb_array_elements(o.tenants) as ot
   where ot->>'league' = ($1->>'league')
     and o.opened is not null
     and o.confidence in ('gold','cross_verified')
     and o.opened >= ($1->>'opened')::int + 5
   order by random()
 $sql$),

-- ------------------------------------------------------ championships
('championship-winner-mc', 'OTH', 'event', 'multiple_choice', 1, 4,
 'Who won the {season}?',
 $sql$
   select ch.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('season', ch.season, 'league', ch.league) as params,
          ch.winner_name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = ch.winner_team_id), '{}') as aliases,
          coalesce(p.score, 0.5) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.championships','id',ch.id)) as fact_refs,
          (ch.confidence in ('gold','cross_verified')) as verified
   from facts.championships ch
   join facts.teams tm on tm.id = ch.winner_team_id
   left join facts.prominence p on p.entity_type = 'championship' and p.entity_id = ch.id
   where tm.state is not null
 $sql$,
 $sql$
   select t.name as candidate
   from facts.teams t
   where t.league = ($1->>'league')
   order by random()
 $sql$),

('championship-winner-ff', 'OTH', 'event', 'free_fill', 2, 2,
 'Which team won the {season}?',
 $sql$
   select ch.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('season', ch.season) as params,
          ch.winner_name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = ch.winner_team_id), '{}') as aliases,
          coalesce(p.score, 0.5) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.championships','id',ch.id)) as fact_refs,
          (ch.confidence in ('gold','cross_verified')) as verified
   from facts.championships ch
   join facts.teams tm on tm.id = ch.winner_team_id
   left join facts.prominence p on p.entity_type = 'championship' and p.entity_id = ch.id
   where tm.state is not null
 $sql$,
 null),

('championship-year-mc', 'OTH', 'event', 'multiple_choice', 2, 4,
 'In what year was the {season} played?',
 $sql$
   select ch.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('season', ch.season, 'year', ch.year::text) as params,
          ch.year::text as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.championships','id',ch.id)) as fact_refs,
          (ch.confidence in ('gold','cross_verified')) as verified
   from facts.championships ch
   join facts.teams tm on tm.id = ch.winner_team_id
   left join facts.prominence p on p.entity_type = 'championship' and p.entity_id = ch.id
   where tm.state is not null
     and ch.season !~ ('' || ch.year::text)
 $sql$,
 $sql$
   select (($1->>'year')::int + off)::text as candidate
   from (values (1),(-1),(2),(-2),(3),(-3),(4),(-4)) as offsets(off)
   order by random()
 $sql$),

-- ------------------------------------------------------------- drafts
('draft-team-mc', 'NFL', 'event', 'multiple_choice', 2, 4,
 'Which team selected {player} with the #{pick} overall pick of the {year} NFL Draft?',
 $sql$
   select d.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('player', d.player_name, 'pick', d.overall_pick::text, 'year', d.year::text) as params,
          d.team_name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = tm.id), '{}') as aliases,
          0.5 as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.drafts','id',d.id)) as fact_refs,
          (d.confidence in ('gold','cross_verified')) as verified
   from facts.drafts d
   join facts.teams tm on tm.name = d.team_name and tm.league = d.league
   where d.overall_pick <= 15 and tm.state is not null
 $sql$,
 $sql$
   -- Teams that actually drafted that year; the compiler lint drops the
   -- answer team itself from the pool.
   select candidate from (
     select distinct d2.team_name as candidate
     from facts.drafts d2
     where d2.year = ($1->>'year')::int
   ) pool order by random()
 $sql$),

('draft-player-ff', 'NFL', 'event', 'free_fill', 3, 2,
 'Which player did the {team} take #{pick} overall in the {year} NFL Draft?',
 $sql$
   select d.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('team', d.team_name, 'pick', d.overall_pick::text, 'year', d.year::text) as params,
          d.player_name as answer,
          case when d.player_name ~ '^\S+\s+\S+' and split_part(d.player_name, ' ', -1) !~ '^(Jr|Sr|II|III|IV)\.?$'
               then array[split_part(d.player_name, ' ', -1)]
               else '{}'::text[] end as aliases,
          case when d.overall_pick <= 3 then 0.5 else 0.3 end as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.drafts','id',d.id)) as fact_refs,
          (d.confidence in ('gold','cross_verified')) as verified
   from facts.drafts d
   join facts.teams tm on tm.name = d.team_name and tm.league = d.league
   where d.overall_pick <= 5 and tm.state is not null
 $sql$,
 null),

('draft-college-mc', 'CFB', 'franchise_college', 'multiple_choice', 2, 4,
 '{player}, the #{pick} overall pick in the {year} NFL Draft, played college football where?',
 $sql$
   select d.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('player', d.player_name, 'pick', d.overall_pick::text, 'year', d.year::text) as params,
          d.college as answer,
          '{}'::text[] as aliases,
          case when d.overall_pick <= 5 then 0.5 else 0.35 end as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.drafts','id',d.id)) as fact_refs,
          (d.confidence in ('gold','cross_verified')) as verified
   from facts.drafts d
   join facts.teams tm on tm.name = d.team_name and tm.league = d.league
   where d.overall_pick <= 10 and d.college is not null and tm.state is not null
 $sql$,
 $sql$
   select candidate from (
     select distinct d2.college as candidate
     from facts.drafts d2
     where d2.college is not null and d2.round = 1
   ) pool order by random()
 $sql$),

-- ------------------------------------------------------------- awards
('award-winner-ff', 'MLB', 'player', 'free_fill', 2, 2,
 'Who won the MLB {award} award in {year} ({notes} league)?',
 $sql$
   select aw.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('award', aw.award, 'year', aw.year::text,
                            'notes', case aw.notes when 'AL' then 'American' when 'NL' then 'National' else coalesce(aw.notes,'') end) as params,
          aw.winner_name as answer,
          case when aw.winner_name ~ '^\S+\s+\S+'
                and split_part(aw.winner_name, ' ', -1) !~ '^(Jr|Sr|II|III|IV)\.?$'
               then array[split_part(aw.winner_name, ' ', -1)]
               else '{}'::text[] end as aliases,
          coalesce(p.score, 0.35) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.awards','id',aw.id)) as fact_refs,
          (aw.confidence in ('gold','cross_verified') and a.confidence in ('gold','cross_verified')) as verified
   from facts.awards aw
   join facts.athletes a on a.id = aw.winner_athlete_id
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where aw.league = 'MLB' and aw.notes in ('AL','NL')
     and a.birth_state is not null
 $sql$,
 null),

('award-winner-mc', 'MLB', 'player', 'multiple_choice', 2, 4,
 'Who won the MLB {award} award in {year} ({notes} league)?',
 $sql$
   select aw.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('award', aw.award, 'year', aw.year::text,
                            'notes', case aw.notes when 'AL' then 'American' when 'NL' then 'National' else coalesce(aw.notes,'') end) as params,
          aw.winner_name as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.35) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.awards','id',aw.id)) as fact_refs,
          (aw.confidence in ('gold','cross_verified') and a.confidence in ('gold','cross_verified')) as verified
   from facts.awards aw
   join facts.athletes a on a.id = aw.winner_athlete_id
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where aw.league = 'MLB' and aw.notes in ('AL','NL')
     and a.birth_state is not null
 $sql$,
 $sql$
   select candidate from (
     select distinct aw2.winner_name as candidate
     from facts.awards aw2
     where aw2.award = ($1->>'award')
       and abs(aw2.year - ($1->>'year')::int) <= 12
   ) pool order by random()
 $sql$),

-- ------------------------------------------------------------ athletes
('athlete-birth-city-mc', 'OTH', 'player', 'multiple_choice', 2, 4,
 '{athlete} was born in which {statename} city?',
 $sql$
   select a.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('athlete', a.full_name, 'statename', t.name, 'state', a.birth_state) as params,
          a.birth_city as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.3) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.athletes','id',a.id)) as fact_refs,
          (a.confidence in ('gold','cross_verified')) as verified
   from facts.athletes a
   join public.territories t on t.id = a.birth_state
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where a.birth_city is not null
     and coalesce(p.score, 0) >= 0.3
 $sql$,
 $sql$
   select candidate from (
     select distinct a2.birth_city as candidate
     from facts.athletes a2
     where a2.birth_state = ($1->>'state') and a2.birth_city is not null
   ) pool order by random()
 $sql$),

('athlete-pro-team-ff', 'OTH', 'player', 'free_fill', 3, 2,
 'Name the {league} team {athlete} played for.',
 $sql$
   select a.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('athlete', a.full_name,
            'league', case pro->>'league'
              when 'National Football League' then 'NFL'
              when 'National Basketball Association' then 'NBA'
              when 'Major League Baseball' then 'MLB'
              when 'National Hockey League' then 'NHL'
              else pro->>'league' end) as params,
          pro->>'team_name' as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.3) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.athletes','id',a.id)) as fact_refs,
          (a.confidence in ('gold','cross_verified')) as verified
   from facts.athletes a
   cross join lateral (
     select pt as pro from jsonb_array_elements(a.pro_teams) pt
     where pt->>'league' in ('National Football League','National Basketball Association',
                             'Major League Baseball','National Hockey League')
   ) only_major
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where a.birth_state is not null
     and coalesce(p.score, 0) >= 0.35
     and 1 = (select count(*) from jsonb_array_elements(a.pro_teams) pt2
              where pt2->>'league' in ('National Football League','National Basketball Association',
                                       'Major League Baseball','National Hockey League'))
 $sql$,
 null),

('athlete-college-mc', 'OTH', 'franchise_college', 'multiple_choice', 2, 4,
 'Where did {athlete} go to college?',
 $sql$
   select a.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('athlete', a.full_name) as params,
          college->>'name' as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.3) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.athletes','id',a.id)) as fact_refs,
          (a.confidence in ('gold','cross_verified')) as verified
   from facts.athletes a
   cross join lateral (
     select c as college from jsonb_array_elements(a.colleges) c limit 1
   ) first_college
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where a.birth_state is not null
     and coalesce(p.score, 0) >= 0.35
     and jsonb_array_length(a.colleges) = 1
 $sql$,
 $sql$
   select candidate from (
     select distinct c2->>'name' as candidate
     from facts.athletes a2
     cross join lateral jsonb_array_elements(a2.colleges) c2
     where c2->>'name' is not null
   ) pool order by random()
 $sql$),

('athlete-decade-mc', 'MLB', 'player', 'multiple_choice', 2, 4,
 'In which decade did {athlete} make his MLB debut?',
 $sql$
   select a.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('athlete', a.full_name, 'decade', ((a.career_start / 10) * 10)::text) as params,
          ((a.career_start / 10) * 10)::text || 's' as answer,
          array[((a.career_start / 10) * 10)::text] as aliases,
          coalesce(p.score, 0.3) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.athletes','id',a.id)) as fact_refs,
          (a.confidence in ('gold','cross_verified')) as verified
   from facts.athletes a
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where a.birth_state is not null and a.career_start is not null
     and 'MLB' = any(a.sports)
     and coalesce(p.score, 0) >= 0.3
 $sql$,
 $sql$
   select ((($1->>'decade')::int + off))::text || 's' as candidate
   from (values (10),(-10),(20),(-20),(30),(-30)) as offsets(off)
   where (($1->>'decade')::int + off) between 1870 and 2020
   order by random()
 $sql$),

-- ------------------------------------------------------ season results
('season-wins-mc', 'MLB', 'event', 'multiple_choice', 2, 4,
 'How many regular-season games did the {year} {team} win?',
 $sql$
   select sr.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('team', sr.team_name, 'year', sr.year::text, 'wins', sr.wins::text) as params,
          sr.wins::text as answer,
          '{}'::text[] as aliases,
          0.35 as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.season_results','id',sr.id)) as fact_refs,
          (sr.confidence in ('gold','cross_verified')) as verified
   from facts.season_results sr
   join facts.teams tm on tm.name = sr.team_name and tm.league = sr.league
   where tm.state is not null and sr.wins is not null
     and sr.playoff_result is not null
 $sql$,
 $sql$
   select (($1->>'wins')::int + off)::text as candidate
   from (values (4),(-4),(7),(-7),(11),(-11),(15),(-15)) as offsets(off)
   where ($1->>'wins')::int + off between 30 and 130
   order by random()
 $sql$),

('season-champion-note-ff', 'MLB', 'event', 'free_fill', 3, 2,
 'Which team won the World Series in {year}?',
 $sql$
   select sr.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('year', sr.year::text) as params,
          sr.team_name as answer,
          coalesce((select array_agg(al.alias) from facts.aliases al
                     where al.entity_type = 'team' and al.entity_id = tm.id), '{}') as aliases,
          0.4 as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.season_results','id',sr.id)) as fact_refs,
          (sr.confidence in ('gold','cross_verified')) as verified
   from facts.season_results sr
   join facts.teams tm on tm.name = sr.team_name and tm.league = sr.league
   where tm.state is not null and sr.playoff_result = 'won World Series'
 $sql$,
 null),

-- ------------------------------------------------------------- events
('event-year-mc', 'OTH', 'event', 'multiple_choice', 2, 4,
 'In which year did this happen: {title}?',
 $sql$
   select e.id as family_entity,
          e.state as territory_id,
          jsonb_build_object('title', e.title, 'year', e.year::text) as params,
          e.year::text as answer,
          '{}'::text[] as aliases,
          0.4 as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.events','id',e.id)) as fact_refs,
          (e.confidence in ('gold','cross_verified')) as verified
   from facts.events e
   where e.state is not null and e.year is not null
     and e.title !~ ('' || e.year::text)
 $sql$,
 $sql$
   select (($1->>'year')::int + off)::text as candidate
   from (values (1),(-1),(2),(-2),(3),(-3),(5),(-5)) as offsets(off)
   order by random()
 $sql$),

('team-founded-mc', 'OTH', 'franchise_college', 'multiple_choice', 2, 4,
 'In which decade were the {team} founded?',
 $sql$
   select tm.id as family_entity,
          tm.state as territory_id,
          jsonb_build_object('team', tm.name, 'decade', ((tm.founded / 10) * 10)::text) as params,
          ((tm.founded / 10) * 10)::text || 's' as answer,
          array[((tm.founded / 10) * 10)::text] as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.teams','id',tm.id)) as fact_refs,
          (tm.confidence in ('gold','cross_verified')) as verified
   from facts.teams tm
   left join facts.prominence p on p.entity_type = 'team' and p.entity_id = tm.id
   where tm.state is not null and tm.founded is not null and tm.founded >= 1850
 $sql$,
 $sql$
   select ((($1->>'decade')::int + off))::text || 's' as candidate
   from (values (10),(-10),(20),(-20),(30),(-30)) as offsets(off)
   where (($1->>'decade')::int + off) between 1850 and 2020
   order by random()
 $sql$);
