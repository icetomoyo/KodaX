import { describe, expect, it } from 'vitest';
import { extractArtifactLedger } from './file-tracker.js';

describe('extractArtifactLedger', () => {
  it('records user-attached image inputs in the artifact ledger', () => {
    const ledger = extractArtifactLedger([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please review this screenshot.' },
          {
            type: 'image',
            path: 'C:/repo/screenshots/bug.png',
            mediaType: 'image/png',
          },
        ],
      },
    ]);

    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'image_input',
          sourceTool: 'user-input',
          action: 'attach',
          target: 'C:/repo/screenshots/bug.png',
          metadata: { mediaType: 'image/png' },
        }),
      ]),
    );
  });
});
