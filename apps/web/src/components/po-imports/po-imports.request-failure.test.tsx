import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline, recordEscapedRejections, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: PO imports. Upload & parse, Edit import name, Confirm mappings,
// Re-parse and Cancel import set a busy flag, awaited the action with no
// catch and cleared the flag only when it answered. A request that got no
// answer (offline, a server error, a deploy) left the button spinning, and the
// Cancel import confirm could not be closed, with nothing said.
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Radix Select needs pointer-capture APIs happy-dom does not implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh }),
}));
// sonner's real toast blows the stack under happy-dom (po-upload-form tests).
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/po-imports', () => ({
  presignPoUploadAction: vi.fn(),
  recordPoUploadAction: vi.fn(),
  parsePoImportAction: vi.fn(),
  renamePoImportAction: vi.fn(),
  confirmPoImportMappingsAction: vi.fn(),
  approvePoImportAction: vi.fn(),
  cancelPoImportAction: vi.fn(),
  createItemsFromPoLinesAction: vi.fn(),
  findDuplicatesForPoLinesAction: vi.fn(),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { toast } from 'sonner';

import {
  cancelPoImportAction,
  confirmPoImportMappingsAction,
  parsePoImportAction,
  presignPoUploadAction,
  recordPoUploadAction,
  renamePoImportAction,
} from '@/server/actions/po-imports';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

import { MappingConfirmation } from './mapping-confirmation';
import { PoImportDetail } from './po-import-detail';
import { PoImportRenameButton } from './po-import-rename-button';
import { PO_UPLOAD_READ_UNANSWERED_MESSAGE, PoUploadForm } from './po-upload-form';

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Upload & parse when a step gets no answer', () => {
  beforeEach(() => {
    vi.mocked(presignPoUploadAction).mockResolvedValue({
      ok: true,
      data: { uploadUrl: 'https://storage.test/put', storagePath: 'org-1/po-imports/x.csv' },
    } as never);
    vi.mocked(recordPoUploadAction).mockResolvedValue({
      ok: true,
      data: { id: 'imp-1', duplicateOf: null, reimportOfCancelled: null },
    } as never);
    vi.mocked(parsePoImportAction).mockResolvedValue({ ok: true, data: undefined } as never);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })) as never);
    // happy-dom has no SubtleCrypto; only getting past the digest matters.
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) },
    });
  });

  async function upload() {
    const user = userEvent.setup();
    render(<PoUploadForm />);
    await user.upload(
      screen.getByLabelText('PO file (PDF or CSV)'),
      new File(['sku,qty\nA,1\n'], 'order.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: /Upload & parse/i }));
  }

  // Before the upload is recorded, the same file sent again is safe: it is
  // recorded by its checksum, so a file that did land opens its import.
  it('says the file was not uploaded, and Upload & parse works again', async () => {
    vi.mocked(presignPoUploadAction).mockRejectedValueOnce(offline());
    await upload();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'upload the file')),
    );
    expect(screen.getByRole('button', { name: /Upload & parse/i })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  // After it is recorded, only the read got no answer: the file is there, and
  // the page stays put rather than opening the import with no connection.
  it('says the file was uploaded but not read, and points to PO imports without leaving the page', async () => {
    vi.mocked(parsePoImportAction).mockRejectedValueOnce(offline());
    await upload();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(PO_UPLOAD_READ_UNANSWERED_MESSAGE),
    );
    expect(recordPoUploadAction).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Upload & parse/i })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(recordPoUploadAction).mockRejectedValueOnce(signInRedirect());
    await upload();
    await waitFor(() => expect(recordPoUploadAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Edit import name when the save gets no answer', () => {
  it('says the import was not renamed, keeps the dialog and the typed name, and Save works again', async () => {
    vi.mocked(renamePoImportAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <PoImportRenameButton poImportId="imp-1" currentName="August order" fileName="po.csv" />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit import name' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('PO name');
    await user.clear(field);
    await user.type(field, 'September order');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'rename the import'),
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('PO name')).toHaveValue('September order');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

const MAPPING_LINE = {
  id: 'l1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 3,
  uom_original: 'EA',
  description: 'Home Jersey',
  unit_cost: 40,
  line_total: 120,
  vendor_item_number: null,
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: 0.95,
  exception_reason: null,
  variant_size: 'M',
  variant_size_original: 'M',
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: 'Red',
  jersey_number: null,
  player_name: null,
  group_hint: 'Home Jersey',
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: 0.4,
} as PoImportLineRow;

describe('Confirm mappings when the save gets no answer', () => {
  it('says the mappings were not confirmed, keeps the answer, and Confirm mappings works again', async () => {
    vi.mocked(confirmPoImportMappingsAction).mockRejectedValueOnce(offline());
    const onConfirmed = vi.fn();
    const user = userEvent.setup();
    render(
      <MappingConfirmation
        poImportId="11111111-1111-4111-8111-111111111111"
        lines={[MAPPING_LINE]}
        editable
        onConfirmed={onConfirmed}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Ignore — clear these values' }));
    await user.click(screen.getByRole('button', { name: /confirm mappings/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'confirm the mappings'),
      ),
    );
    expect(screen.getByRole('button', { name: /confirm mappings/i })).toBeEnabled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

const HEADER = {
  id: 'imp-1',
  organization_id: 'org-1',
  uploaded_by: 'user-1',
  source_type: 'csv',
  extraction_confidence: null,
  extraction_model: null,
  vendor_id: null,
  warehouse_id: null,
  file_name: 'po.csv',
  file_mime_type: 'text/csv',
  file_size: 2048,
  storage_path: 'imports/po.csv',
  sha256: 'abc',
  status: 'parsed',
  parse_error: null,
  approved_po_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as PoImportRow;

const DETAIL_LINE = {
  id: 'line-1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 10,
  uom_original: 'EA',
  description: 'Blue Widget carton',
  unit_cost: 2,
  line_total: 20,
  vendor_item_number: 'V-BW-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
} as PoImportLineRow;

function renderDetail() {
  return render(
    <PoImportDetail
      header={HEADER}
      lines={[DETAIL_LINE]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={[]}
      items={[]}
    />,
  );
}

describe('the PO import page when a request gets no answer', () => {
  it('Re-parse says the import was not parsed again, and works again', async () => {
    vi.mocked(parsePoImportAction).mockRejectedValueOnce(offline());
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Re-parse' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'parse the import again'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Re-parse' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Cancel import says why inside the confirm, which stays open and closes with Keep import', async () => {
    vi.mocked(cancelPoImportAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel import' }));
    const sentence = requestFailedMessage(offline(), 'cancel the import');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    expect(within(dialog).getByRole('button', { name: 'Cancel import' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Keep import' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refresh).not.toHaveBeenCalled();
  });
});
