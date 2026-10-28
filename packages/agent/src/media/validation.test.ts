import { describe, expect, it } from 'vitest';

import type { KodaXInputArtifact } from './types.js';
import {
  KodaXMediaError,
  validateInputArtifactsForModel,
} from './index.js';

const ARK_CODING_IMAGE_MODELS = [
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'MiniMax-M3',
] as const;

describe('validateInputArtifactsForModel', () => {
  it('accepts supported image artifacts', () => {
    const artifacts: KodaXInputArtifact[] = [
      {
        kind: 'image',
        path: '/tmp/shot.png',
        mediaType: 'image/png',
        source: 'clipboard',
      },
    ];
    expect(() => validateInputArtifactsForModel(artifacts, {
      provider: 'kimi',
      model: 'k2.6',
    })).not.toThrow();
  });

  it.each(ARK_CODING_IMAGE_MODELS)(
    'accepts image artifacts for the verified Ark Coding %s route',
    (model) => {
      expect(() => validateInputArtifactsForModel([
        {
          kind: 'image',
          path: '/tmp/shot.png',
          mediaType: 'image/png',
        },
      ], {
        provider: 'ark-coding',
        model,
      })).not.toThrow();
    },
  );

  it('accepts direct-path image/gif when the model route supports images', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'image',
        path: '/tmp/animated.gif',
        mediaType: 'image/gif',
      },
    ], {
      provider: 'mimo-coding',
      model: 'mimo-v2.6-flash',
    })).not.toThrow();
  });

  it('rejects text-only providers before send', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'image',
        path: '/tmp/shot.png',
        mediaType: 'image/png',
      },
    ], {
      provider: 'codex-cli',
    })).toThrow(KodaXMediaError);

    try {
      validateInputArtifactsForModel([
        {
          kind: 'image',
          path: '/tmp/shot.png',
          mediaType: 'image/png',
        },
      ], {
        provider: 'codex-cli',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('MODEL_INPUT_UNSUPPORTED');
    }
  });

  it('rejects unsupported image media types', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'image',
        path: '/tmp/shot.bmp',
        mediaType: 'image/bmp',
      } as unknown as KodaXInputArtifact,
    ], {
      provider: 'kimi',
      model: 'k2.6',
    })).toThrow(KodaXMediaError);
  });

  it('fails closed for future video artifacts until runtime send path exists', () => {
    try {
      validateInputArtifactsForModel([
        {
          kind: 'video',
          path: '/tmp/movie.mp4',
          mediaType: 'video/mp4',
        },
      ], {
        provider: 'minimax-coding',
        model: 'MiniMax-M3',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('MODEL_INPUT_UNSUPPORTED');
      expect((error as KodaXMediaError).detail).toContain('provider-native-unwired');
      return;
    }
    throw new Error('Expected validation to reject video artifacts');
  });

  it('rejects unsupported video media types before capability status checks', () => {
    try {
      validateInputArtifactsForModel([
        {
          kind: 'video',
          path: '/tmp/movie.mkv',
          mediaType: 'video/x-matroska',
        } as KodaXInputArtifact,
      ], {
        provider: 'minimax-coding',
        model: 'minimax-m3',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      return;
    }
    throw new Error('Expected validation to reject unsupported video media type');
  });

  it('rejects file artifacts with a stable model-input error', () => {
    try {
      validateInputArtifactsForModel([
        {
          kind: 'file',
          path: '/tmp/report.pdf',
          mediaType: 'application/pdf',
          name: 'report.pdf',
        },
      ], {
        provider: 'kimi',
        model: 'k2.6',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('MODEL_INPUT_UNSUPPORTED');
      expect((error as KodaXMediaError).detail).toContain('not wired');
      return;
    }
    throw new Error('Expected validation to reject file artifacts');
  });

  it('rejects disagreeing file mediaType aliases', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'file',
        path: '/tmp/report.pdf',
        mediaType: 'application/pdf',
        mimeType: 'text/plain',
      },
    ], {
      provider: 'kimi',
      model: 'k2.6',
    })).toThrow(KodaXMediaError);
  });
});
