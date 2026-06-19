import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SIDEBAR_DOM_ID } from './sidebar-pref';
import { SidebarToggleButton } from './sidebar-toggle-button';

describe('SidebarToggleButton', () => {
  it('labels itself "Hide sidebar" + aria-expanded true when shown', () => {
    render(<SidebarToggleButton hidden={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAttribute('aria-controls', SIDEBAR_DOM_ID);
  });

  it('labels itself "Show sidebar" + aria-expanded false when hidden', () => {
    render(<SidebarToggleButton hidden={true} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Show sidebar' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).not.toHaveAttribute('aria-controls');
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<SidebarToggleButton hidden={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
