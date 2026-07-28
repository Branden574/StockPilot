-- 0301_po_import_line_variants.sql
--
-- Extends the PO-imports chassis with variant fields so a size run arrives as
-- a size run instead of N unrelated lines.
--
-- The chassis itself (staging status machine, SHA256 idempotency with
-- supersede lineage, per-line confidence, needs_review UI, and the 0233
-- suggestion-not-link discipline) is untouched. suggested_group_id follows
-- that discipline exactly: it is ADVISORY, and a human must accept it.
--
-- NUMBERING: the plan called this 0300; 0300 was taken by
-- product_groups org-immutability before this task ran, so it ships as 0301.
-- Content is unchanged.

alter table public.po_import_lines
  add column if not exists variant_size text,
  /* The size EXACTLY as printed on the document. Never overwritten. */
  add column if not exists variant_size_original text,
  add column if not exists variant_size_system text,
  add column if not exists variant_width text,
  add column if not exists variant_fit text,
  add column if not exists variant_color text,
  add column if not exists jersey_number text,
  add column if not exists player_name text,
  /* Free-text style/group hint the extractor read off the document
     ("Nike Pegasus 41 FD2722"). Used to build a candidate group key. */
  add column if not exists group_hint text,
  /* The serial the DOCUMENT printed for this line, verbatim, or NULL.
     Never invented, never a placeholder ('N/A', '0000'), and never derived
     from a jersey number. It exists so a SERIALIZED category's import line
     can be settled at review; receipt-time enforcement (post_receipt_v2)
     is untouched and remains the authority on what actually arrives. */
  add column if not exists serial_hint text,
  /* ADVISORY group match. Never auto-linked — mirrors suggested_item_id (0233). */
  add column if not exists suggested_group_id uuid
    references public.product_groups(id) on delete set null,
  /* Confidence the AI attached to its COLUMN MAPPING for this line, separate
     from extraction_confidence (how well it read the characters). */
  add column if not exists mapping_confidence numeric(4,3);

comment on column public.po_import_lines.suggested_group_id is
  'Advisory "possible existing product group" for this line. Informational '
  'only — the user must accept it in review before anything is linked. Never '
  'linked automatically (the 0233 suggestion-not-link discipline).';

comment on column public.po_import_lines.jersey_number is
  'Uniform number read off the document, as TEXT with leading zeroes intact. '
  'NEVER written to a serial column, and never used as an identity key.';

comment on column public.po_import_lines.variant_size_original is
  'The size string exactly as printed. Requirements: "preserve source values".';

comment on column public.po_import_lines.serial_hint is
  'The serial number the document printed for this line, verbatim, or NULL. '
  'NEVER invented and NEVER a placeholder — a serialized line with no printed '
  'serial stays blocked in review rather than being given a fake one. Distinct '
  'from jersey_number, which is a uniform number and never a serial.';

create index if not exists po_import_lines_suggested_group_idx
  on public.po_import_lines (suggested_group_id)
  where suggested_group_id is not null;
