import { describe, expect, it } from 'vitest';

import { metadata as contact } from './contact/page';
import { metadata as pricing } from './pricing/page';
import { metadata as privacy } from './privacy/page';
import { metadata as security } from './security/page';
import { metadata as support } from './support/page';
import { metadata as terms } from './terms/page';

/**
 * CONFLICTS D15: these pages hard-coded " · StockPilot" in their titles while
 * the root layout's template (`%s · StockPilot`) adds it again, so the tab read
 * "Pricing · StockPilot · StockPilot". The suffix now comes from the template.
 */
describe('marketing page titles', () => {
  it.each([
    ['contact', contact, 'Contact'],
    ['pricing', pricing, 'Pricing'],
    ['privacy', privacy, 'Privacy Policy'],
    ['security', security, 'Security & Compliance'],
    ['support', support, 'Support'],
    ['terms', terms, 'Terms of Service'],
  ])('/%s carries no hand-written suffix', (_page, meta, title) => {
    expect(meta.title).toBe(title);
  });
});
