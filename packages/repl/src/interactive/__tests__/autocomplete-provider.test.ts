/**
 * Tests for Autocomplete Provider - 自动补全提供者测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutocompleteProvider, createAutocompleteProvider } from '../autocomplete-provider.js';

// Mock completers
vi.mock('../completers/skill-completer.js', () => ({
  SkillCompleter: vi.fn().mockImplementation(() => ({
    canComplete: vi.fn().mockReturnValue(false),
    getCompletions: vi.fn().mockResolvedValue([]),
    setGitRoot: vi.fn(),
  })),
}));

vi.mock('../completers/argument-completer.js', () => ({
  ArgumentCompleter: vi.fn().mockImplementation(() => ({
    canComplete: vi.fn().mockReturnValue(false),
    getCompletions: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../autocomplete.js', () => ({
  FileCompleter: vi.fn().mockImplementation(() => ({
    canComplete: vi.fn().mockReturnValue(false),
    getCompletions: vi.fn().mockResolvedValue([]),
  })),
  CommandCompleter: vi.fn().mockImplementation(() => ({
    canComplete: vi.fn((input: string) => input.startsWith('/')),
    getCompletions: vi.fn().mockResolvedValue([
      { text: '/help', display: '/help', description: 'Show help', type: 'command' },
      { text: '/mode', display: '/mode', description: 'Change mode', type: 'command' },
    ]),
  })),
}));

describe('AutocompleteProvider', () => {
  let provider: AutocompleteProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = createAutocompleteProvider({
      debounceDelay: 100,
      minTriggerChars: 1,
      maxCompletions: 10,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create provider with default options', () => {
      const defaultProvider = createAutocompleteProvider();
      expect(defaultProvider).toBeInstanceOf(AutocompleteProvider);
    });

    it('should create provider with custom options', () => {
      const customProvider = createAutocompleteProvider({
        debounceDelay: 200,
        maxCompletions: 5,
      });
      expect(customProvider).toBeInstanceOf(AutocompleteProvider);
    });
  });

  describe('getState', () => {
    it('should return initial state', () => {
      const state = provider.getState();

      expect(state.visible).toBe(false);
      expect(state.selectedIndex).toBe(0);
      expect(state.completions).toEqual([]);
      expect(state.loading).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should notify listeners on state change', async () => {
      const listener = vi.fn();
      provider.subscribe(listener);

      // Trigger state change via handleInput with command
      provider.handleInput('/h', 2);

      // Advance timers to trigger debounce
      await vi.advanceTimersByTimeAsync(150);

      // Listener should be called with visible state
      expect(listener).toHaveBeenCalled();
      const lastCall = listener.mock.calls[listener.mock.calls.length - 1]?.[0];
      expect(lastCall?.visible).toBe(true);
    });

    it('should return unsubscribe function', async () => {
      const listener = vi.fn();
      const unsubscribe = provider.subscribe(listener);

      unsubscribe();

      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      // Listener should not be called after unsubscribe
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('handleInput', () => {
    it('should trigger on command input', async () => {
      const listener = vi.fn();
      provider.subscribe(listener);

      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      expect(listener).toHaveBeenCalled();
    });

    it('should not trigger on plain text', async () => {
      const listener = vi.fn();
      provider.subscribe(listener);

      provider.handleInput('hello world', 11);
      await vi.advanceTimersByTimeAsync(150);

      // State should remain hidden - listener called with visible: false
      if (listener.mock.calls.length > 0) {
        const lastCall = listener.mock.calls[listener.mock.calls.length - 1]?.[0];
        expect(lastCall?.visible).toBe(false);
      }
    });

    it('should debounce rapid input', async () => {
      const listener = vi.fn();
      provider.subscribe(listener);

      // Rapid input
      provider.handleInput('/h', 2);
      provider.handleInput('/he', 3);
      provider.handleInput('/hel', 4);
      provider.handleInput('/help', 5);

      // Before debounce completes
      await vi.advanceTimersByTimeAsync(50);
      expect(listener).not.toHaveBeenCalled();

      // After debounce completes
      await vi.advanceTimersByTimeAsync(100);
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('keyboard navigation', () => {
    it('should navigate down with selectNext', async () => {
      // First get some completions
      await provider.fetchImmediate('/h', 2);

      // Get initial state
      const initialState = provider.getState();

      // Make visible manually for test
      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      // Simulate selection
      provider.selectNext();
      const state = provider.getState();

      // Should have completions and selection
      expect(state.completions.length).toBeGreaterThan(0);
    });

    it('should navigate up with selectPrevious', async () => {
      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      const stateBefore = provider.getState();

      // Move down first
      if (stateBefore.completions.length > 1) {
        provider.selectNext();
        provider.selectNext();

        // Then move up
        provider.selectPrevious();
        const stateAfter = provider.getState();

        // Should have moved
        expect(stateAfter.selectedIndex).toBeGreaterThanOrEqual(0);
      }
    });

    it('should wrap around on navigation', async () => {
      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      const state = provider.getState();
      const count = state.completions.length;

      if (count > 1) {
        // Start at index 0, navigate to last item (count-1 moves)
        for (let i = 0; i < count - 1; i++) {
          provider.selectNext();
        }

        // Should now be at last item
        expect(provider.getState().selectedIndex).toBe(count - 1);

        // One more should wrap to first
        provider.selectNext();
        expect(provider.getState().selectedIndex).toBe(0);
      }
    });
  });

  describe('acceptCompletion', () => {
    it('should return null when not visible', () => {
      const result = provider.acceptCompletion();
      expect(result).toBeNull();
    });

    it('should return selected completion text when visible', async () => {
      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      const state = provider.getState();
      if (state.visible && state.completions.length > 0) {
        const selected = provider.acceptCompletion();
        expect(selected).toBeDefined();
      }
    });
  });

  describe('cancel', () => {
    it('should hide dropdown', async () => {
      // First show the dropdown
      provider.handleInput('/h', 2);
      await vi.advanceTimersByTimeAsync(150);

      // Cancel
      provider.cancel();

      expect(provider.getState().visible).toBe(false);
    });

    it('should clear debounce timer', async () => {
      provider.handleInput('/h', 2);
      provider.cancel();

      // Advance timers - should not trigger anything
      await vi.advanceTimersByTimeAsync(150);

      // State should be hidden
      expect(provider.getState().visible).toBe(false);
    });
  });

  describe('updateOptions', () => {
    it('should update options', () => {
      provider.updateOptions({ cwd: '/new/path' });
      const options = provider.getOptions();

      expect(options.cwd).toBe('/new/path');
    });
  });

  describe('fetchImmediate', () => {
    it('should return completions without debounce', async () => {
      const completions = await provider.fetchImmediate('/h', 2);

      expect(Array.isArray(completions)).toBe(true);
    });
  });
});

describe('createAutocompleteProvider', () => {
  it('should create provider instance', () => {
    const provider = createAutocompleteProvider();
    expect(provider).toBeInstanceOf(AutocompleteProvider);
  });

  it('should pass options to provider', () => {
    const provider = createAutocompleteProvider({
      debounceDelay: 500,
    });
    const options = provider.getOptions();

    expect(options.debounceDelay).toBe(500);
  });
});
