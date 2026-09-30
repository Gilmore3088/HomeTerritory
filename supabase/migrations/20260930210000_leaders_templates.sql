-- Phase 3, catalog v1.2: the leaders family (spec: "Leaders & records").
-- facts.leaders rows are undisputed single-season stat leads derived from
-- Lahman's Batting.csv (etl/seeds/lahman.ts) -- tied seasons never land in
-- the table at all, so every instance here has exactly one defensible
-- answer by construction. Territory follows the leader's birth state,
-- like the award templates; leaders whose athlete row is missing (below
-- the notability bar) or state-less simply do not compile.

insert into facts.question_templates
  (slug, sport, link_type, format, tier_base, option_count, text_template, answer_sql, distractor_sql)
values

('season-hr-leader-mc', 'MLB', 'player', 'multiple_choice', 2, 4,
 'Who led the {league_long} in home runs in {year}?',
 $sql$
   select l.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('year', l.year_from::text,
            'league_long', case l.notes when 'AL' then 'American League'
                                        when 'NL' then 'National League'
                                        else l.notes end,
            'stat', l.stat, 'league_code', l.notes) as params,
          l.holder_name as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.leaders','id',l.id)) as fact_refs,
          (l.confidence in ('gold','cross_verified') and a.confidence in ('gold','cross_verified')) as verified
   from facts.leaders l
   join facts.athletes a on a.id = l.holder_athlete_id
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where l.scope = 'season' and l.stat = 'HR' and a.birth_state is not null
 $sql$,
 $sql$
   -- Other undisputed HR leaders of the same league, close enough in time
   -- to be plausible; being a different season's leader makes them wrong
   -- for the asked year by construction.
   select candidate from (
     select distinct l2.holder_name as candidate
     from facts.leaders l2
     where l2.scope = 'season' and l2.stat = 'HR'
       and l2.notes = ($1->>'league_code')
       and abs(l2.year_from - ($1->>'year')::int) <= 12
   ) pool order by random()
 $sql$),

('season-hr-leader-ff', 'MLB', 'player', 'free_fill', 3, 2,
 'Who led the {league_long} in home runs in {year}?',
 $sql$
   select l.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('year', l.year_from::text,
            'league_long', case l.notes when 'AL' then 'American League'
                                        when 'NL' then 'National League'
                                        else l.notes end) as params,
          l.holder_name as answer,
          case when l.holder_name ~ '^\S+\s+\S+'
                and split_part(l.holder_name, ' ', -1) !~ '^(Jr|Sr|II|III|IV)\.?$'
               then array[split_part(l.holder_name, ' ', -1)]
               else '{}'::text[] end as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.leaders','id',l.id)) as fact_refs,
          (l.confidence in ('gold','cross_verified') and a.confidence in ('gold','cross_verified')) as verified
   from facts.leaders l
   join facts.athletes a on a.id = l.holder_athlete_id
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where l.scope = 'season' and l.stat = 'HR' and a.birth_state is not null
 $sql$,
 null),

('season-rbi-leader-mc', 'MLB', 'player', 'multiple_choice', 2, 4,
 'Who drove in the most runs in the {league_long} in {year}?',
 $sql$
   select l.id as family_entity,
          a.birth_state as territory_id,
          jsonb_build_object('year', l.year_from::text,
            'league_long', case l.notes when 'AL' then 'American League'
                                        when 'NL' then 'National League'
                                        else l.notes end,
            'league_code', l.notes) as params,
          l.holder_name as answer,
          '{}'::text[] as aliases,
          coalesce(p.score, 0.4) as prominence,
          jsonb_build_array(jsonb_build_object('table','facts.leaders','id',l.id)) as fact_refs,
          (l.confidence in ('gold','cross_verified') and a.confidence in ('gold','cross_verified')) as verified
   from facts.leaders l
   join facts.athletes a on a.id = l.holder_athlete_id
   left join facts.prominence p on p.entity_type = 'athlete' and p.entity_id = a.id
   where l.scope = 'season' and l.stat = 'RBI' and a.birth_state is not null
 $sql$,
 $sql$
   select candidate from (
     select distinct l2.holder_name as candidate
     from facts.leaders l2
     where l2.scope = 'season' and l2.stat = 'RBI'
       and l2.notes = ($1->>'league_code')
       and abs(l2.year_from - ($1->>'year')::int) <= 12
   ) pool order by random()
 $sql$);
