import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replaceMock = vi.fn();
const warningMock = vi.fn();

let searchValue = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchValue),
}));

vi.mock('sonner', () => ({
  toast: {
    warning: (...a: unknown[]) => warningMock(...a),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { UploadRecoveryToast } from './upload-recovery-toast';

beforeEach(() => {
  replaceMock.mockReset();
  warningMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('UploadRecoveryToast', () => {
  it('fires the toast and strips the query param when upload_recovery=1', () => {
    searchValue = 'upload_recovery=1';
    render(<UploadRecoveryToast />);
    expect(warningMock).toHaveBeenCalledTimes(1);
    // URL was cleared (no other params left → falls back to pathname).
    expect(replaceMock).toHaveBeenCalled();
  });

  it('does nothing when the query param is absent', () => {
    searchValue = '';
    render(<UploadRecoveryToast />);
    expect(warningMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
