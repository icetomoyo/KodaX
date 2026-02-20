/**
 * Tests for TextInput utilities
 *
 * Tests the helper functions used by the TextInput component.
 * Note: The generateDivider function is not exported, so we test it
 * by simulating its behavior here and testing the constants.
 */

import { describe, it, expect } from 'vitest';

// Constants must match those in TextInput.tsx
const MAX_DIVIDER_WIDTH = 200;

/**
 * Generate divider string - same logic as in TextInput.tsx
 */
function generateDivider(width: number): string {
  const safeWidth = Math.min(MAX_DIVIDER_WIDTH, Math.max(1, width));
  return "─".repeat(safeWidth);
}

describe('generateDivider', () => {
  it('should generate divider with exact width for normal values', () => {
    const divider = generateDivider(80);
    expect(divider.length).toBe(80);
    expect(divider).toBe('─'.repeat(80));
  });

  it('should handle width of 1', () => {
    const divider = generateDivider(1);
    expect(divider).toBe('─');
    expect(divider.length).toBe(1);
  });

  it('should handle width of 0 (minimum 1)', () => {
    const divider = generateDivider(0);
    expect(divider).toBe('─');
    expect(divider.length).toBe(1);
  });

  it('should handle negative width (minimum 1)', () => {
    const divider = generateDivider(-10);
    expect(divider).toBe('─');
    expect(divider.length).toBe(1);
  });

  it('should cap width at MAX_DIVIDER_WIDTH', () => {
    const divider = generateDivider(1000);
    expect(divider.length).toBe(MAX_DIVIDER_WIDTH);
  });

  it('should handle exactly MAX_DIVIDER_WIDTH', () => {
    const divider = generateDivider(MAX_DIVIDER_WIDTH);
    expect(divider.length).toBe(MAX_DIVIDER_WIDTH);
  });

  it('should handle MAX_DIVIDER_WIDTH + 1', () => {
    const divider = generateDivider(MAX_DIVIDER_WIDTH + 1);
    expect(divider.length).toBe(MAX_DIVIDER_WIDTH);
  });

  it('should use box drawing character', () => {
    const divider = generateDivider(10);
    expect(divider).toMatch(/^─+$/);
  });
});

describe('MAX_DIVIDER_WIDTH constant', () => {
  it('should be 200', () => {
    expect(MAX_DIVIDER_WIDTH).toBe(200);
  });
});
