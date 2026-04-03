-- Run once in Supabase SQL Editor (if not already applied)

create table if not exists planner_data (
  key text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table planner_data enable row level security;

drop policy if exists planner_data_anon_all on planner_data;
create policy planner_data_anon_all
  on planner_data
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- Add to Realtime only if not already there (avoids error 42710 on re-run)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'planner_data'
  ) then
    alter publication supabase_realtime add table planner_data;
  end if;
end $$;
