import { describe, expect, it } from 'vitest';
import { buildFeedbackContext } from '../services/ClickUpFeedbackService';

describe('buildFeedbackContext', () => {
  it('includes customer, site, level, and path when provided', () => {
    const text = buildFeedbackContext({
      customer: { friendlyName: 'Exxon', customerId: 'exxon' },
      garage: { name: 'Energy Garage' },
      level: { name: 'Level 1' },
      pathname: '/exxon/energy-garage/level-1',
    });
    expect(text).toContain('Customer: Exxon');
    expect(text).toContain('Site: Energy Garage');
    expect(text).toContain('Level: Level 1');
    expect(text).toContain('URL: /exxon/energy-garage/level-1');
  });

  it('handles empty context', () => {
    expect(buildFeedbackContext({})).toBe('');
  });
});
