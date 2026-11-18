-- Weekly Score database setup for Supabase (Postgres 15+).
-- Run once in the Supabase SQL editor on a fresh project.
--
-- The weekly data lives in a private schema that the Data API does not
-- expose. The page can only reach it through the ws_* functions below,
-- and each of those checks the access key from the embed URL against a
-- stored SHA-256 hash. The publishable API key in app.js is public by
-- design; on its own it can call ws_heartbeat and nothing else useful.
--
-- After running this file, store the hash of your access key:
--   insert into weeklyscore.access (key_sha256) values ('<64 hex chars>');
-- To rotate the key later:
--   update weeklyscore.access set key_sha256 = '<new 64 hex chars>';

create schema if not exists weeklyscore;
revoke all on schema weeklyscore from public, anon, authenticated;

create table weeklyscore.weeks (
  week          text primary key
                check (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  score         smallint check (score between 1 and 10),
  moved_needle  text not null default '' check (char_length(moved_needle) <= 10000),
  one_change    text not null default '' check (char_length(one_change) <= 10000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Single row holding the SHA-256 (hex) of the access key in the embed URL.
create table weeklyscore.access (
  id          boolean primary key default true check (id),
  key_sha256  text not null check (key_sha256 ~ '^[0-9a-f]{64}$')
);

-- Single row the keep-alive job updates so the free project sees activity.
create table weeklyscore.heartbeat (
  id       boolean primary key default true check (id),
  beat_at  timestamptz not null default now()
);
insert into weeklyscore.heartbeat default values;

alter table weeklyscore.weeks     enable row level security;
alter table weeklyscore.access    enable row level security;
alter table weeklyscore.heartbeat enable row level security;
revoke all on all tables in schema weeklyscore from public, anon, authenticated;

create function weeklyscore.check_key(k text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if k is null or not exists (
    select 1
    from weeklyscore.access a
    where a.key_sha256 = encode(sha256(convert_to(k, 'UTF8')), 'hex')
  ) then
    raise exception 'invalid access key' using errcode = '28000';
  end if;
end;
$$;
revoke execute on function weeklyscore.check_key(text) from public, anon, authenticated;

create function public.ws_list(k text)
returns table (
  week text,
  score smallint,
  moved_needle text,
  one_change text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform weeklyscore.check_key(k);
  return query
    select w.week, w.score, w.moved_needle, w.one_change, w.updated_at
    from weeklyscore.weeks w
    order by w.week desc;
end;
$$;

-- Patch semantics: a null argument leaves that field unchanged, so two
-- devices editing different fields of the same week don't overwrite each other.
create function public.ws_save(
  k text,
  p_week text,
  p_score int default null,
  p_moved_needle text default null,
  p_one_change text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r weeklyscore.weeks;
begin
  perform weeklyscore.check_key(k);
  insert into weeklyscore.weeks as w (week, score, moved_needle, one_change)
  values (p_week, p_score, coalesce(p_moved_needle, ''), coalesce(p_one_change, ''))
  on conflict (week) do update set
    score        = coalesce(p_score, w.score),
    moved_needle = coalesce(p_moved_needle, w.moved_needle),
    one_change   = coalesce(p_one_change, w.one_change),
    updated_at   = now()
  returning w.* into r;
  return jsonb_build_object(
    'week', r.week,
    'score', r.score,
    'moved_needle', r.moved_needle,
    'one_change', r.one_change,
    'updated_at', r.updated_at
  );
end;
$$;

create function public.ws_clear(k text, p_week text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform weeklyscore.check_key(k);
  delete from weeklyscore.weeks w where w.week = p_week;
end;
$$;

-- Keyless on purpose: it only bumps one timestamp, and the keep-alive
-- workflow can call it without a repository secret.
create function public.ws_heartbeat()
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  update weeklyscore.heartbeat set beat_at = now() returning beat_at;
$$;

revoke execute on function public.ws_list(text) from public;
revoke execute on function public.ws_save(text, text, int, text, text) from public;
revoke execute on function public.ws_clear(text, text) from public;
revoke execute on function public.ws_heartbeat() from public;
grant execute on function public.ws_list(text) to anon, authenticated;
grant execute on function public.ws_save(text, text, int, text, text) to anon, authenticated;
grant execute on function public.ws_clear(text, text) to anon, authenticated;
grant execute on function public.ws_heartbeat() to anon, authenticated;
