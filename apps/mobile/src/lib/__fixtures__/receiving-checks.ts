/**
 * TEST-ONLY answers of the receiving checklist routes (F4-1), in the shapes
 * the web's ReceivingChecklistService returns (forPurchaseOrder, getRun,
 * getEditor, saveRun, start), so the phone's strict readers are tested
 * against what the server sends.
 */

export const IDS = {
  org: '0f400000-0000-4000-8000-000000000001',
  po: '0f400000-0000-4000-8000-000000000002',
  v1: '0f400000-0000-4000-8000-000000000003',
  v2: '0f400000-0000-4000-8000-000000000004',
  rcptA: '0f400000-0000-4000-8000-000000000005',
  rcptB: '0f400000-0000-4000-8000-000000000006',
  rcptC: '0f400000-0000-4000-8000-000000000007',
  runA: '0f400000-0000-4000-8000-000000000008',
  runB: '0f400000-0000-4000-8000-000000000009',
  proc: '0f400000-0000-4000-8000-00000000000a',
} as const;

export const STEPS = [
  {
    key: 's1',
    kind: 'check',
    label: 'Packing slip matches this purchase order',
    help: null,
    required: true,
  },
  { key: 's2', kind: 'check', label: 'Boxes arrived undamaged', help: null, required: false },
  { key: 's3', kind: 'count', label: 'Number of boxes received', help: null, required: false },
  {
    key: 's4',
    kind: 'text',
    label: 'Anything missing, extra or damaged?',
    help: 'Say what',
    required: false,
  },
];

/** v1 live Oct 1 to Oct 3, v2 live from Oct 3. */
export function poChecksAnswer() {
  return {
    checks: {
      ok: true,
      versions: [
        {
          id: IDS.v2,
          versionNumber: 2,
          title: 'Delivery checks',
          steps: STEPS,
          publishedAt: '2026-10-03T15:00:00.000Z',
          retiredAt: null,
        },
        {
          id: IDS.v1,
          versionNumber: 1,
          title: 'Delivery checks',
          steps: STEPS,
          publishedAt: '2026-10-01T15:00:00.000Z',
          retiredAt: '2026-10-03T15:00:00.000Z',
        },
      ],
      runs: [
        {
          id: IDS.runA,
          receiptId: IDS.rcptA,
          versionId: IDS.v1,
          status: 'completed',
          results: { s1: { value: 'fail', note: 'Wrong slip' }, s2: { value: 'pass' } },
          startedAt: '2026-10-02T16:00:00.000Z',
          startedByName: 'Pat Lee',
          completedAt: '2026-10-02T16:10:00.000Z',
          completedByName: 'Pat Lee',
        },
        {
          id: IDS.runB,
          receiptId: IDS.rcptB,
          versionId: IDS.v2,
          status: 'in_progress',
          results: { s1: { value: 'pass' } },
          startedAt: '2026-10-04T16:00:00.000Z',
          startedByName: 'Deleted user',
          completedAt: null,
          completedByName: null,
        },
      ],
    },
  };
}

export function runAnswer() {
  return {
    run: {
      run: {
        id: IDS.runB,
        status: 'in_progress',
        results: { s1: { value: 'pass' }, s3: { value: 12 } },
        note: null,
        revision: 3,
        startedAt: '2026-10-04T16:00:00.000Z',
        startedByName: 'Pat Lee',
        completedAt: null,
        completedByName: null,
      },
      version: {
        id: IDS.v2,
        versionNumber: 2,
        title: 'Delivery checks',
        steps: STEPS,
        procedure: { id: IDS.proc, title: 'Receiving SOP' },
      },
      newerVersionNumber: null,
      receipt: {
        id: IDS.rcptB,
        receiptNumber: 'R-1002',
        status: 'posted',
        receivedAt: '2026-10-04T15:00:00.000Z',
        reversedAt: null,
      },
      po: { id: IDS.po, poNumber: 'PO-2026-0052', supplierName: 'Acme Supply' },
      about: {
        unitsReceived: 48,
        lineCount: 3,
        warehouseName: 'Main',
        stockOwner: { kind: 'ok', value: ['North Charter'] },
        billTo: { kind: 'unavailable' },
        stillToCome: { kind: 'ok', value: 2 },
      },
      lines: [{ itemName: 'Notebook', sku: 'NB-1', qtyReceived: 48, qtyAccepted: 48 }],
      canRecord: true,
      timeZone: 'America/Los_Angeles',
    },
  };
}

export function editorAnswer() {
  return {
    editor: {
      live: {
        id: IDS.v2,
        versionNumber: 2,
        title: 'Delivery checks',
        steps: STEPS,
        procedureId: IDS.proc,
        procedureTitle: 'Receiving SOP',
        publishedAt: '2026-10-03T15:00:00.000Z',
        publishedByName: 'Pat Lee',
        retiredAt: null,
        retiredByName: null,
        runCount: 1,
      },
      history: [
        {
          id: IDS.v1,
          versionNumber: 1,
          title: 'Delivery checks',
          steps: STEPS,
          procedureId: null,
          procedureTitle: null,
          publishedAt: '2026-10-01T15:00:00.000Z',
          publishedByName: 'Pat Lee',
          retiredAt: '2026-10-03T15:00:00.000Z',
          retiredByName: 'Sam Ortiz',
          runCount: 1,
        },
      ],
      nextVersionNumber: 3,
      gate: {
        canPostReceipt: true,
        canRecordChecklist: true,
        canPublishChecklist: true,
        canAddPoFile: true,
      },
      procedures: [{ id: IDS.proc, title: 'Receiving SOP' }],
      proceduresUnavailable: false,
      timeZone: 'America/Los_Angeles',
    },
  };
}
