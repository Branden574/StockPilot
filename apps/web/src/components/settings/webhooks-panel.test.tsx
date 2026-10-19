/**
 * Webhooks & alerts (Settings > Integrations): the icon-only Send test and
 * Delete buttons and the show-once signing secret's Copy and dismiss buttons
 * carry accessible names (CONFLICTS D17), the event boxes are checkboxes with
 * "New order" preselected, and Delete keeps its native confirm with the same
 * words.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/integration-endpoints', () => ({
  createIntegrationEndpointAction: vi.fn(),
  deleteIntegrationEndpointAction: vi.fn(),
  setIntegrationEndpointEnabledAction: vi.fn(),
  testIntegrationEndpointAction: vi.fn(),
}));

import { WebhooksPanel, type PanelEndpoint } from './webhooks-panel';

const ENDPOINTS: PanelEndpoint[] = [
  {
    id: 'e1',
    type: 'slack',
    url: 'https://hooks.slack.com/services/T000/B000/XXXX',
    eventTypes: ['order.created'],
    enabled: true,
    description: 'Ops channel',
    lastDeliveryAt: null,
    lastStatus: null,
    hasSecret: false,
  },
  {
    id: 'e2',
    type: 'webhook',
    url: 'https://example.test/hook',
    eventTypes: ['order.created', 'po.received'],
    enabled: false,
    description: null,
    lastDeliveryAt: null,
    lastStatus: null,
    hasSecret: false,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebhooksPanel', () => {
  it("names each row's icon buttons after its endpoint, never its URL", () => {
    render(<WebhooksPanel endpoints={ENDPOINTS} />);
    expect(
      screen.getByRole('button', { name: 'Send test to Slack endpoint Ops channel' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete Slack endpoint Ops channel' }),
    ).toBeInTheDocument();
    const del = screen.getByRole('button', { name: /^Delete .*endpoint$/ });
    expect(del.getAttribute('aria-label')).not.toContain('example.test');
    expect(del).toHaveAttribute('title', 'Delete');
  });

  it('keeps the native confirm words on Delete and does nothing when cancelled', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const actions = await import('@/server/actions/integration-endpoints');
    render(<WebhooksPanel endpoints={ENDPOINTS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Slack endpoint Ops channel' }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete this endpoint? Events will stop being delivered to it.',
    );
    expect(vi.mocked(actions.deleteIntegrationEndpointAction)).not.toHaveBeenCalled();
  });

  it('offers the events as checkboxes with New order preselected', () => {
    render(<WebhooksPanel endpoints={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add endpoint/ }));
    const group = screen.getByRole('group', { name: 'Send these events' });
    const boxes = group.querySelectorAll('[role="checkbox"]');
    expect(boxes.length).toBeGreaterThan(20);
    const newOrder = screen.getByRole('checkbox', { name: 'New order' });
    expect(newOrder).toBeChecked();
    fireEvent.click(newOrder);
    expect(newOrder).not.toBeChecked();
    // Destination chips are toggle buttons.
    expect(screen.getByRole('button', { name: 'Slack' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('names the show-once signing secret buttons', async () => {
    const actions = await import('@/server/actions/integration-endpoints');
    vi.mocked(actions.createIntegrationEndpointAction).mockResolvedValueOnce({
      ok: true,
      data: { secret: 'whsec_example' },
    } as never);
    render(<WebhooksPanel endpoints={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add endpoint/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Webhook' }));
    fireEvent.change(screen.getByLabelText(/URL/), {
      target: { value: 'https://example.test/hook' },
    });
    const addButtons = screen.getAllByRole('button', { name: /Add endpoint/ });
    fireEvent.click(addButtons[addButtons.length - 1]!);
    await waitFor(() => expect(screen.getByText('whsec_example')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Done, hide the signing secret' }),
    ).toBeInTheDocument();
  });
});
