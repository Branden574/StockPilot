import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAINTENANCE_MAX_PHOTO_BYTES } from '../maintenance/constants';

import {
  canRemoveExceptionEvidence,
  describeEvidenceEvent,
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS,
  EXCEPTION_EVIDENCE_CONTENT_TYPES,
  EXCEPTION_EVIDENCE_EXTENSIONS,
  EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NONE_COPY,
  EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_PRIVACY_COPY,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
  exceptionEvidenceAddDisabledReason,
  exceptionEvidenceCountLabel,
  exceptionEvidenceTimesCopy,
  exceptionEvidenceTypeForExtension,
} from './exception-evidence';

const TZ = 'America/Chicago';
const here = path.dirname(fileURLToPath(import.meta.url));

describe('limits match migration 0375', () => {
  // Literal pins: these are transcriptions of the migration, and a drift
  // between the two lets the UI promise what the database refuses.
  const migration = readFileSync(
    path.resolve(here, '../../../../supabase/migrations/0375_exception_evidence.sql'),
    'utf8',
  );

  it('8 live photos, the constant the record RPC uses', () => {
    expect(EXCEPTION_EVIDENCE_MAX_PHOTOS).toBe(8);
    expect(migration).toMatch(/c_max_live\s+constant integer := 8;/);
  });

  it('10 MB, the bucket limit and the byte_size check', () => {
    expect(EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    expect(migration).toContain('10 * 1024 * 1024');
    expect(migration).toContain('byte_size between 1 and 10485760');
    // The same budget as maintenance photos, on purpose (one phone resize path).
    expect(EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES).toBe(MAINTENANCE_MAX_PHOTO_BYTES);
  });

  it('notes and reasons up to 500 characters', () => {
    expect(EXCEPTION_EVIDENCE_NOTE_MAX).toBe(500);
    expect(migration).toContain('char_length(note) between 1 and 500');
    expect(migration).toContain('char_length(v_reason) > 500');
  });

  it('PNG, JPEG and WEBP only, as the bucket pins', () => {
    expect([...EXCEPTION_EVIDENCE_CONTENT_TYPES].sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(migration).toContain("array['image/png','image/jpeg','image/webp']");
    expect([...EXCEPTION_EVIDENCE_EXTENSIONS]).toEqual(['jpg', 'jpeg', 'png', 'webp']);
  });

  it('a capture time may run at most 5 minutes ahead', () => {
    expect(EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS).toBe(5 * 60 * 1000);
    expect(migration).toContain("p_captured_at > now() + interval '5 minutes'");
  });
});

describe('exceptionEvidenceTypeForExtension', () => {
  it('maps each allowed extension, and nothing else', () => {
    expect(exceptionEvidenceTypeForExtension('jpg')).toBe('image/jpeg');
    expect(exceptionEvidenceTypeForExtension('JPEG')).toBe('image/jpeg');
    expect(exceptionEvidenceTypeForExtension('png')).toBe('image/png');
    expect(exceptionEvidenceTypeForExtension('webp')).toBe('image/webp');
    expect(exceptionEvidenceTypeForExtension('heic')).toBeNull();
    expect(exceptionEvidenceTypeForExtension('gif')).toBeNull();
    expect(exceptionEvidenceTypeForExtension('')).toBeNull();
  });
});

describe('exceptionEvidenceAddDisabledReason', () => {
  const ok = { resolved: false, canAct: true, online: true, liveCount: 3 };

  it('is null when a photo can be added', () => {
    expect(exceptionEvidenceAddDisabledReason(ok)).toBeNull();
    expect(exceptionEvidenceAddDisabledReason({ ...ok, liveCount: 7 })).toBeNull();
  });

  it('refuses at the cap, not before', () => {
    expect(exceptionEvidenceAddDisabledReason({ ...ok, liveCount: 8 })).toBe(
      EXCEPTION_EVIDENCE_CAP_COPY,
    );
    expect(EXCEPTION_EVIDENCE_CAP_COPY).toContain('at most 8 photos');
  });

  it('says offline, and that nothing is saved for later', () => {
    expect(exceptionEvidenceAddDisabledReason({ ...ok, online: false })).toBe(
      EXCEPTION_EVIDENCE_OFFLINE_COPY,
    );
    expect(EXCEPTION_EVIDENCE_OFFLINE_COPY).toMatch(/not saved offline/);
  });

  it('a resolved row and a reader without permission are told so even offline', () => {
    expect(
      exceptionEvidenceAddDisabledReason({ ...ok, resolved: true, online: false, canAct: false }),
    ).toBe(EXCEPTION_EVIDENCE_RESOLVED_COPY);
    expect(
      exceptionEvidenceAddDisabledReason({ ...ok, canAct: false, online: false, liveCount: 8 }),
    ).toBe(EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY);
    // Offline outranks the cap: reconnecting is the first thing that helps.
    expect(exceptionEvidenceAddDisabledReason({ ...ok, online: false, liveCount: 8 })).toBe(
      EXCEPTION_EVIDENCE_OFFLINE_COPY,
    );
  });
});

describe('canRemoveExceptionEvidence mirrors exception_evidence_remove', () => {
  const base = {
    resolved: false,
    canAct: true,
    removed: false,
    viewerIsUploader: true,
    viewerIsManager: false,
  };

  it('the uploader may remove their own photo while open', () => {
    expect(canRemoveExceptionEvidence(base)).toBe(true);
  });

  it("a manager may remove anyone's photo", () => {
    expect(
      canRemoveExceptionEvidence({ ...base, viewerIsUploader: false, viewerIsManager: true }),
    ).toBe(true);
  });

  it('another staff member may not', () => {
    expect(canRemoveExceptionEvidence({ ...base, viewerIsUploader: false })).toBe(false);
  });

  it('nobody may once resolved, once removed, or without the act gate', () => {
    expect(canRemoveExceptionEvidence({ ...base, resolved: true, viewerIsManager: true })).toBe(
      false,
    );
    expect(canRemoveExceptionEvidence({ ...base, removed: true })).toBe(false);
    expect(canRemoveExceptionEvidence({ ...base, canAct: false, viewerIsManager: true })).toBe(
      false,
    );
  });
});

describe('exceptionEvidenceTimesCopy names each clock', () => {
  it('same day: times only, each labelled with its clock', () => {
    // 15:02 and 15:40 UTC are 10:02 and 10:40 AM in Chicago (CDT).
    expect(
      exceptionEvidenceTimesCopy(
        { capturedAt: '2026-09-27T15:02:00Z', uploadedAt: '2026-09-27T15:40:00Z' },
        TZ,
      ),
    ).toBe("Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)");
  });

  it("different days in the org's zone: dates added to both", () => {
    expect(
      exceptionEvidenceTimesCopy(
        { capturedAt: '2026-09-26T23:50:00Z', uploadedAt: '2026-09-27T15:40:00Z' },
        TZ,
      ),
    ).toBe("Taken Sep 26, 6:50 PM (device's clock) · uploaded Sep 27, 10:40 AM (server's clock)");
  });

  it("uses the org's zone, not UTC: 04:30 UTC on the 28th is still the 27th in Chicago", () => {
    expect(
      exceptionEvidenceTimesCopy(
        { capturedAt: '2026-09-27T20:00:00Z', uploadedAt: '2026-09-28T04:30:00Z' },
        TZ,
      ),
    ).toBe("Taken 3:00 PM (device's clock) · uploaded 11:30 PM (server's clock)");
  });

  it('no capture time: the upload time only, and says the device did not say', () => {
    expect(
      exceptionEvidenceTimesCopy({ capturedAt: null, uploadedAt: '2026-09-27T15:40:00Z' }, TZ),
    ).toBe("Uploaded Sep 27, 10:40 AM (server's clock). The device did not say when it was taken.");
    expect(
      exceptionEvidenceTimesCopy({ capturedAt: 'garbage', uploadedAt: '2026-09-27T15:40:00Z' }, TZ),
    ).toBe("Uploaded Sep 27, 10:40 AM (server's clock). The device did not say when it was taken.");
  });

  it('never presents a missing upload time as a time', () => {
    expect(exceptionEvidenceTimesCopy({ capturedAt: null, uploadedAt: null }, TZ)).toBe(
      'Upload time not available.',
    );
    expect(
      exceptionEvidenceTimesCopy({ capturedAt: '2026-09-27T15:02:00Z', uploadedAt: null }, TZ),
    ).toBe("Taken Sep 27, 10:02 AM (device's clock). Upload time not available.");
  });
});

describe('describeEvidenceEvent', () => {
  it('an added photo: "Photo added by X", its two times, its note', () => {
    expect(
      describeEvidenceEvent({
        kind: 'evidence_added',
        actorLabel: 'Maria Lopez',
        capturedAt: '2026-09-27T15:02:00Z',
        uploadedAt: '2026-09-27T15:40:00Z',
        note: '  shelf empty  ',
        timeZone: TZ,
      }),
    ).toEqual({
      headline: 'Photo added by Maria Lopez',
      detail: "Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)",
      note: 'shelf empty',
    });
  });

  it('a removed photo: "Photo removed by X" and the reason, no times', () => {
    expect(
      describeEvidenceEvent({
        kind: 'evidence_removed',
        actorLabel: 'Sam Reed',
        note: 'blurry',
        timeZone: TZ,
      }),
    ).toEqual({ headline: 'Photo removed by Sam Reed', detail: null, note: 'Reason: blurry' });
    expect(
      describeEvidenceEvent({ kind: 'evidence_removed', actorLabel: 'Sam Reed' }).note,
    ).toBeNull();
  });

  it('a deleted account reads as the label the service gives it', () => {
    expect(
      describeEvidenceEvent({ kind: 'evidence_added', actorLabel: 'Former member' }).headline,
    ).toBe('Photo added by Former member');
  });
});

describe('panel copy', () => {
  it('the count label', () => {
    expect(exceptionEvidenceCountLabel(3)).toBe('Photos (3 of 8)');
    expect(exceptionEvidenceCountLabel(-1)).toBe('Photos (0 of 8)');
  });

  it('a failed read is never worded as "no photos"', () => {
    expect(EXCEPTION_EVIDENCE_UNAVAILABLE_COPY).not.toBe(EXCEPTION_EVIDENCE_NONE_COPY);
    expect(EXCEPTION_EVIDENCE_UNAVAILABLE_COPY.toLowerCase()).not.toContain('no photos');
  });

  it('every sentence is plain: no "book", no emoji', () => {
    const all = [
      EXCEPTION_EVIDENCE_OFFLINE_COPY,
      EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
      EXCEPTION_EVIDENCE_RESOLVED_COPY,
      EXCEPTION_EVIDENCE_CAP_COPY,
      EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
      EXCEPTION_EVIDENCE_NONE_COPY,
      EXCEPTION_EVIDENCE_REJECTED_COPY,
      EXCEPTION_EVIDENCE_PRIVACY_COPY,
      exceptionEvidenceCountLabel(2),
      exceptionEvidenceTimesCopy({ capturedAt: null, uploadedAt: '2026-09-27T15:40:00Z' }, TZ),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/\bbooks?\b/i);
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
