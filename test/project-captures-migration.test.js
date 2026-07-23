const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../intent/app/supabase/migrations/20260723072224_project_captures.sql',
), 'utf8');

test('private capture migration pins bounded storage and immutable manifests', () => {
  assert.match(migration, /'project-captures',\s*'project-captures',\s*false,\s*8388608/s);
  assert.match(migration, /constraint project_captures_kind_mime_check/);
  assert.match(migration, /project_id text references public\.projects\(id\) on delete restrict/);
  assert.match(migration, /task_id uuid references public\.tasks\(id\) on delete restrict/);
  assert.match(migration, /revoke insert, update, delete on public\.project_captures from authenticated/);
  assert.match(migration, /security definer[\s\S]+project_capture_is_finalized|project_capture_is_finalized[\s\S]+security definer/);
  assert.match(migration, /not public\.project_capture_is_finalized\(storage\.objects\.name\)/);
  assert.match(migration, /cardinality\(storage\.foldername\(name\)\) = 3/);
});

test('capture task transaction binds packet, object metadata, and uploader', () => {
  assert.match(migration, /packet objective must match the task title/);
  assert.match(migration, /jsonb_array_length\(p_captures\) < 1 or jsonb_array_length\(p_captures\) > 6/);
  assert.match(migration, /total_size > 20971520/);
  assert.match(migration, /capture kind does not match its MIME type/);
  assert.match(migration, /o\.owner_id = auth\.uid\(\)::text/);
  assert.match(migration, /\(o\.metadata ->> 'size'\)::bigint = capture_size/);
  assert.match(migration, /o\.metadata ->> 'mimetype'/);
  assert.match(migration, /'approval_required', true/);
  assert.match(migration, /p_task_id is the browser-generated idempotency key/);
  assert.match(migration, /task id already exists with different capture work/);
  assert.match(migration, /existing task capture manifest does not match retry/);
  assert.match(migration, /grant execute on function public\.create_task_with_captures[\s\S]+to authenticated/);
  assert.match(migration, /this task has private captures; update the Phewsh CLI before claiming it/);
  assert.match(migration, /create or replace function public\.claim_task_with_captures/);
  assert.match(migration, /p_capture_protocol is distinct from 'private-captures-v1'/);
  assert.match(migration, /task capture packet does not match its immutable manifest/);
});

test('capture deletion is race-fenced, Storage-API mediated, and retryable', () => {
  assert.match(migration, /create or replace function public\.prepare_capture_task_deletion/);
  assert.match(migration, /select \* into t[\s\S]+for update/);
  assert.match(migration, /when t\.status = 'open'[\s\S]+when t\.status = 'claimed'/);
  assert.match(migration, /e\.event_type = 'execution_started'/);
  assert.match(migration, /'capture_cleanup',[\s\S]+'state', 'pending'/);
  assert.match(migration, /public\.project_capture_can_delete\(storage\.objects\.name\)/);
  assert.match(migration, /create or replace function public\.finalize_capture_task_deletion/);
  assert.match(migration, /private capture objects still exist in Storage/);
  assert.match(migration, /delete from public\.project_captures/);
  assert.match(migration, /t\.packet - 'captures' - 'capture_cleanup'/);
  assert.match(migration, /'captures_deleted_count', capture_count/);
  assert.match(migration, /'capture_cleanup', 'complete'/);
  assert.match(migration, /drop policy if exists "Creator or owner can cancel"/);
  assert.match(migration, /revoke update on public\.tasks from authenticated, anon/);
});
