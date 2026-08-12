-- Give a PO import a HUMAN name, separate from the uploaded file's name.
--
-- The problem this solves: phone-scanned imports arrive as `image.jpg`,
-- `IMG_4471.HEIC`, `scan.pdf`. Those are the only labels the imports list and
-- the import detail page have ever had, so a stack of scans is unreadable and
-- unsearchable. `file_name` KEEPS its current meaning (the real uploaded source
-- filename, used for troubleshooting "which document was this?") and stays
-- visible everywhere; `display_name` is the label a person types.
--
-- Nullable with NO backfill on purpose: every historical row keeps rendering
-- `file_name` exactly as it does today (the readers are all
-- `display_name ?? file_name`), so shipping this migration ahead of the code —
-- and running the code without it once rolled back — are both non-events.
--
-- Length guard mirrors the house pattern for a nullable user-editable label
-- (0261 public_request_links / inventory_items.public_display_name): a single
-- inline CHECK that is a no-op for NULL and bounds the text otherwise. 160 is
-- the agreed ceiling — long enough for "August DC4 Book Order — Follett
-- replacement shipment", short enough to render in a table cell.

alter table public.po_imports
  add column if not exists display_name text
    check (display_name is null or length(display_name) between 1 and 160);

comment on column public.po_imports.display_name is
  'Optional human name a user gives this import (e.g. "August DC4 Book Order"), '
  'shown in place of file_name in the UI. NULL means "no name yet" — readers '
  'fall back to file_name, and nothing is backfilled. '
  'DISPLAY METADATA ONLY: never build a Storage path, an object key, a database '
  'identifier, a filename on disk, or an authorization/lookup token from this '
  'value, and never render it as HTML — it is user-supplied free text. '
  'It is NOT part of duplicate identity: same-file detection is and stays '
  'sha256-based (po_imports_org_sha_uniq on (organization_id, sha256)), so two '
  'imports cannot be distinguished by naming them differently.';

-- Deliberately NOT indexed. The imports list searches this column with an
-- unanchored ILIKE alongside file_name, but po_imports is a desktop-upload
-- workflow table (nowhere near PO-ledger scale — see PoImportsService.list's
-- header), and file_name has never carried an index for the same search either.
-- Adding a trigram index here would be speculative; revisit only with a real
-- slow query.

-- ROLLBACK (reversible, non-destructive to anything else):
--   alter table public.po_imports drop column if exists display_name;
-- Dropping the column loses only the typed names; file_name, sha256,
-- storage_path, the lineage columns (reimported_from_id, superseded_at) and
-- po_imports_org_sha_uniq are untouched by this migration in either direction.
