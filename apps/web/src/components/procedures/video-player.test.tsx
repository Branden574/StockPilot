import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VideoPlayer } from './video-player';

const two = [
  { id: 'v1', title: 'Dock walkthrough', signed_url: 'https://lab/v1.mp4', mime_type: 'video/mp4' },
  { id: 'v2', title: null, signed_url: 'https://lab/v2.mp4', mime_type: 'video/mp4' },
];

describe('VideoPlayer', () => {
  it('renders nothing without videos', () => {
    const { container } = render(<VideoPlayer videos={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('one clip: no tab strip, the player and its title', () => {
    const { container } = render(<VideoPlayer videos={[two[0]!]} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('src', 'https://lab/v1.mp4');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(screen.getByText('Dock walkthrough')).toBeInTheDocument();
  });

  it('several clips: a "Procedure videos" tablist that swaps the clip', () => {
    const { container } = render(<VideoPlayer videos={two} />);
    const list = screen.getByRole('tablist', { name: 'Procedure videos' });
    expect(list).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Dock walkthrough', 'Video 2']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tabs[1]!);
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://lab/v2.mp4');
  });

  it('a clip that fails says so instead of a dead black box', () => {
    const { container } = render(<VideoPlayer videos={[two[0]!]} />);
    fireEvent.error(container.querySelector('video')!);
    expect(
      screen.getByText(
        'This video failed to load — its link may have expired. Refresh the page to try again.',
      ),
    ).toBeInTheDocument();
  });

  it('a clip without a link says "Video unavailable."', () => {
    render(<VideoPlayer videos={[{ ...two[0]!, signed_url: null }]} />);
    expect(screen.getByText('Video unavailable.')).toBeInTheDocument();
  });
});
