/**
 * Re-export shim: the AFM width table was promoted to
 * `@/lib/pdf/helvetica-metrics` when `pdf-layout.ts` started measuring real
 * identifier values at runtime (2026-08-04, the long-SKU overlap fix). Test
 * suites keep importing from here; production code imports the lib module
 * directly.
 */
export {
  advance,
  COURIER_ADVANCE,
  HELVETICA,
  HELVETICA_BOLD,
  safeWidth,
  width,
  type FontName,
} from '@/lib/pdf/helvetica-metrics';
