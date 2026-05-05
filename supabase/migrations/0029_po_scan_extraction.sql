-- 0029_po_scan_extraction.sql
-- ============================================================================
-- Adds the bits we need for phone-scanned POs:
--   • po_imports.source_type now accepts 'scan' (image or photo of a printed PO)
--   • po_import_lines.extraction_confidence numeric(4,3) — how confident the
--     vision model was that it READ the line correctly off the image. This is
--     separate from match_confidence (which is about internal-item matching
--     after extraction). The review UI uses extraction_confidence to highlight
--     low-confidence rows in yellow/red so the operator's eyes go straight
--     to the few fields that need a tweak.
-- ============================================================================

-- Drop + re-add the source_type constraint so we can include 'scan'.
alter table public.po_imports
  drop constraint if exists po_imports_source_type_check;
alter table public.po_imports
  add constraint po_imports_source_type_check
  check (source_type in ('pdf','csv','xlsx','manual','scan'));

-- Per-line extraction confidence from the vision model. NULL for legacy
-- imports (CSV / PDF parsed by deterministic parsers — those are 100%).
alter table public.po_import_lines
  add column if not exists extraction_confidence numeric(4,3);

-- Per-import overall extraction confidence (for the header banner in the
-- review UI). NULL for non-scan imports.
alter table public.po_imports
  add column if not exists extraction_confidence numeric(4,3),
  add column if not exists extraction_model text;
