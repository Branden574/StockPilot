-- pgTAP for 0326: the five constraints that complete the HI-8 storage-path
-- floor must exist AND be VALIDATED — 0326 runs add-NOT-VALID + VALIDATE
-- back-to-back (tables are tiny; see the migration header for why the
-- 0323/0324 split was not repeated), so `convalidated` is the property that
-- proves both halves ran.
--
-- Same shape as 0324's test: assert the PROPERTY (enforced for every row),
-- constraint names literal-pinned. Predicate behaviour is not re-tested here —
-- the bodies are 0323's verbatim, and 0323's own test covers what they match.
-- The insert probe at the end proves the floor is LIVE, not merely cataloged.

begin;
select plan(7);

create or replace function _is_validated(tbl text, con text) returns boolean
language sql stable as $$
  select c.convalidated
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public' and r.relname = tbl and c.conname = con
$$;

select ok(_is_validated('item_attachments', 'item_attachments_storage_path_safe'),
  'item_attachments.storage_path shape is validated for every existing row');
select ok(_is_validated('cycle_count_ai_scans', 'cycle_count_ai_scans_photo_storage_path_safe'),
  'cycle_count_ai_scans.photo_storage_path shape is validated');
select ok(_is_validated('import_jobs', 'import_jobs_storage_path_safe'),
  'import_jobs.storage_path shape is validated (the import worker downloads whatever this column names)');
select ok(_is_validated('size_count_training_samples', 'size_count_training_samples_image_storage_path_safe'),
  'size_count_training_samples.image_storage_path shape is validated');
select ok(_is_validated('support_tickets', 'support_tickets_attachment_path_safe'),
  'support_tickets.attachment_path shape is validated (null-or wrapper: a ticket without an attachment stays legal)');

-- The floor is live, not just present in the catalog: a traversal write is
-- refused with the CHECK violation SQLSTATE (23514). import_jobs is probed
-- because its column is the one whose value a worker later DOWNLOADS, and its
-- NOT NULL org/user FKs make the minimal hostile row easy to state.
select throws_ok(
  $$ insert into public.import_jobs (organization_id, user_id, entity, storage_path)
     values ('00000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-000000000002',
             'items',
             '00000000-0000-4000-8000-000000000001/../../item-images/victim/x.csv') $$,
  '23514',
  null,
  'a ".." traversal in import_jobs.storage_path is refused by the new CHECK (23514), whatever the writer'
);

-- And the null-or wrapper genuinely admits NULL: the nullable column must not
-- have been tightened into refusing ticket rows that carry no attachment.
select ok(
  (select pg_get_constraintdef(c.oid) like '%attachment_path IS NULL%'
     from pg_constraint c
    where c.conrelid = 'public.support_tickets'::regclass
      and c.conname = 'support_tickets_attachment_path_safe'),
  'support_tickets_attachment_path_safe keeps the explicit IS NULL leg — attachment-less tickets stay insertable'
);

drop function _is_validated(text, text);
select finish();
rollback;
