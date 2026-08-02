with representative as (
  select distinct on (q.territory_id)
    q.territory_id,
    q.sport,
    q.correct_answer as team_name
  from public.questions q
  where q.active
  order by q.territory_id, q.tier, q.created_at
), derived as (
  select
    r.territory_id,
    r.sport,
    r.team_name,
    t.name as state_name,
    to_jsonb(array_prepend(t.name, array(
      select t2.name
      from public.territories t2
      where t2.id <> r.territory_id
      order by md5(t2.id || r.territory_id)
      limit 3
    ))) as state_options,
    to_jsonb(array_prepend(r.sport, array(
      select s.sport
      from (select distinct sport from public.questions where sport is not null) s
      where s.sport <> r.sport
      order by md5(s.sport || r.territory_id)
      limit 3
    ))) as sport_options,
    to_jsonb(array_prepend(r.territory_id, array(
      select t3.id
      from public.territories t3
      where t3.id <> r.territory_id
      order by md5(t3.id || r.team_name)
      limit 3
    ))) as abbreviation_options
  from representative r
  join public.territories t on t.id = r.territory_id
)
insert into public.questions(
  territory_id, sport, link_type, tier, format, question_text,
  options, correct_answer, aliases, source_url, validation_status, active
)
select d.territory_id, d.sport, v.link_type, v.tier, v.format,
       v.question_text, v.options, v.correct_answer, v.aliases,
       null, 'derived_from_validated_seed', true
from derived d
cross join lateral (
  values
    (
      'team_to_state'::text,
      1,
      'multiple_choice'::text,
      format('The %s are associated with which state?', d.team_name),
      d.state_options,
      d.state_name,
      array[d.territory_id]::text[]
    ),
    (
      'team_to_sport'::text,
      1,
      'multiple_choice'::text,
      format('The %s compete in which sport?', d.team_name),
      d.sport_options,
      d.sport,
      array[]::text[]
    ),
    (
      'team_to_abbreviation'::text,
      2,
      'multiple_choice'::text,
      format('Which state abbreviation belongs with the %s?', d.team_name),
      d.abbreviation_options,
      d.territory_id,
      array[d.state_name]::text[]
    ),
    (
      'state_to_team'::text,
      2,
      'free_fill'::text,
      format('Name the team or program in this question bank that represents %s.', d.state_name),
      '[]'::jsonb,
      d.team_name,
      array[]::text[]
    )
) as v(link_type, tier, format, question_text, options, correct_answer, aliases)
where not exists (
  select 1
  from public.questions existing
  where existing.territory_id = d.territory_id
    and existing.link_type = v.link_type
    and existing.question_text = v.question_text
);
