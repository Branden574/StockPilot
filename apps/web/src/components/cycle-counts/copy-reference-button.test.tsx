import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CopyReferenceButton } from './copy-reference-button';

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  toast.success.mockClear();
  toast.error.mockClear();
});

function setClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe('CopyReferenceButton', () => {
  it('is labelled with the reference it copies', () => {
    render(<CopyReferenceButton reference="CC-000042" />);
    expect(screen.getByRole('button', { name: 'Copy reference CC-000042' })).toBeInTheDocument();
  });

  it('announces success only after the browser confirms the write', async () => {
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    setClipboard(writeText);
    render(<CopyReferenceButton reference="CC-000042" />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('CC-000042');
    expect(toast.success).not.toHaveBeenCalled();
    resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied CC-000042'));
  });

  it('says so when the write is refused, and never claims success', async () => {
    setClipboard(vi.fn(async () => Promise.reject(new Error('denied'))));
    render(<CopyReferenceButton reference="CC-000042" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so when there is no clipboard at all', async () => {
    setClipboard(undefined);
    render(<CopyReferenceButton reference="CC-000042" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
