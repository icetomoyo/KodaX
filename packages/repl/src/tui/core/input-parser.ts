const ESCAPE = "\u001B";

const isCsiParameterByte = (byte: number): boolean => byte >= 0x30 && byte <= 0x3f;
const isCsiIntermediateByte = (byte: number): boolean => byte >= 0x20 && byte <= 0x2f;
const isCsiFinalByte = (byte: number): boolean => byte >= 0x40 && byte <= 0x7e;

type ParsedSequence =
  | { sequence: string; nextIndex: number }
  | "pending"
  | undefined;

function parseCsiSequence(
  input: string,
  startIndex: number,
  prefixLength: number,
): ParsedSequence {
  const csiPayloadStart = startIndex + prefixLength + 1;
  let index = csiPayloadStart;

  for (; index < input.length; index += 1) {
    const byte = input.codePointAt(index);
    if (byte === undefined) {
      return "pending";
    }
    if (isCsiParameterByte(byte) || isCsiIntermediateByte(byte)) {
      continue;
    }
    if (byte === 0x5b && index === csiPayloadStart) {
      continue;
    }
    if (isCsiFinalByte(byte)) {
      return {
        sequence: input.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
    return undefined;
  }

  return "pending";
}

function parseSs3Sequence(
  input: string,
  startIndex: number,
  prefixLength: number,
): ParsedSequence {
  const nextIndex = startIndex + prefixLength + 2;
  if (nextIndex > input.length) {
    return "pending";
  }
  const finalByte = input.codePointAt(nextIndex - 1);
  if (finalByte === undefined || !isCsiFinalByte(finalByte)) {
    return undefined;
  }
  return {
    sequence: input.slice(startIndex, nextIndex),
    nextIndex,
  };
}

function parseControlSequence(
  input: string,
  startIndex: number,
  prefixLength: number,
): ParsedSequence {
  const sequenceType = input[startIndex + prefixLength];
  if (sequenceType === undefined) {
    return "pending";
  }
  if (sequenceType === "[") {
    return parseCsiSequence(input, startIndex, prefixLength);
  }
  if (sequenceType === "O") {
    return parseSs3Sequence(input, startIndex, prefixLength);
  }
  return undefined;
}

function parseEscapedCodePoint(input: string, escapeIndex: number) {
  const nextCodePoint = input.codePointAt(escapeIndex + 1);
  const nextCodePointLength =
    nextCodePoint !== undefined && nextCodePoint > 0xff_ff ? 2 : 1;
  const nextIndex = escapeIndex + 1 + nextCodePointLength;
  return {
    sequence: input.slice(escapeIndex, nextIndex),
    nextIndex,
  };
}

function parseKeypresses(input: string): {
  events: string[];
  pending: string;
} {
  const events: string[] = [];
  let index = 0;
  const pendingFrom = (pendingStartIndex: number) => ({
    events,
    pending: input.slice(pendingStartIndex),
  });

  while (index < input.length) {
    const escapeIndex = input.indexOf(ESCAPE, index);
    if (escapeIndex === -1) {
      events.push(input.slice(index));
      return { events, pending: "" };
    }

    if (escapeIndex > index) {
      events.push(input.slice(index, escapeIndex));
    }

    if (escapeIndex === input.length - 1) {
      return pendingFrom(escapeIndex);
    }

    const parsedSequence = parseControlSequence(input, escapeIndex, 1);
    if (parsedSequence === "pending") {
      return pendingFrom(escapeIndex);
    }
    if (parsedSequence) {
      events.push(parsedSequence.sequence);
      index = parsedSequence.nextIndex;
      continue;
    }

    const next = input[escapeIndex + 1];
    if (next === ESCAPE) {
      if (escapeIndex + 2 >= input.length) {
        return pendingFrom(escapeIndex);
      }
      const doubleEscapeSequence = parseControlSequence(input, escapeIndex, 2);
      if (doubleEscapeSequence === "pending") {
        return pendingFrom(escapeIndex);
      }
      if (doubleEscapeSequence) {
        events.push(doubleEscapeSequence.sequence);
        index = doubleEscapeSequence.nextIndex;
        continue;
      }
      events.push(input.slice(escapeIndex, escapeIndex + 2));
      index = escapeIndex + 2;
      continue;
    }

    const escapedCodePoint = parseEscapedCodePoint(input, escapeIndex);
    events.push(escapedCodePoint.sequence);
    index = escapedCodePoint.nextIndex;
  }

  return { events, pending: "" };
}

export interface CompatInputParser {
  push: (chunk: string) => string[];
  hasPendingEscape: () => boolean;
  flushPendingEscape: () => string | undefined;
  reset: () => void;
}

export function createInputParser(): CompatInputParser {
  let pending = "";

  return {
    push(chunk: string) {
      const parsedInput = parseKeypresses(pending + chunk);
      pending = parsedInput.pending;
      return parsedInput.events;
    },
    hasPendingEscape() {
      return pending.startsWith(ESCAPE);
    },
    flushPendingEscape() {
      if (!pending.startsWith(ESCAPE)) {
        return undefined;
      }
      const pendingEscape = pending;
      pending = "";
      return pendingEscape;
    },
    reset() {
      pending = "";
    },
  };
}
