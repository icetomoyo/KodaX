import { Buffer } from "node:buffer";
import { kittyModifiers } from "./kitty-keyboard.js";

const metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/;
const fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

const keyName: Record<string, string> = {
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[[5~": "pageup",
  "[[6~": "pagedown",
  "[7~": "home",
  "[8~": "end",
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",
  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",
  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",
  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",
  "[Z": "tab",
};

export const nonAlphanumericKeys = [...Object.values(keyName), "backspace"];

const isShiftKey = (code: string): boolean => {
  return [
    "[a",
    "[b",
    "[c",
    "[d",
    "[e",
    "[2$",
    "[3$",
    "[5$",
    "[6$",
    "[7$",
    "[8$",
    "[Z",
  ].includes(code);
};

const isCtrlKey = (code: string): boolean => {
  return [
    "Oa",
    "Ob",
    "Oc",
    "Od",
    "Oe",
    "[2^",
    "[3^",
    "[5^",
    "[6^",
    "[7^",
    "[8^",
  ].includes(code);
};

const kittyKeyRe = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;([\d:]+))?)?u$/;
const kittySpecialKeyRe = /^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$/;

const kittySpecialLetterKeys: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const kittySpecialNumberKeys: Record<number, string> = {
  2: "insert",
  3: "delete",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

const kittyCodepointNames: Record<number, string> = {
  27: "escape",
  9: "tab",
  127: "delete",
  8: "backspace",
  57358: "capslock",
  57359: "scrolllock",
  57360: "numlock",
  57361: "printscreen",
  57362: "pause",
  57363: "menu",
  57376: "f13",
  57377: "f14",
  57378: "f15",
  57379: "f16",
  57380: "f17",
  57381: "f18",
  57382: "f19",
  57383: "f20",
  57384: "f21",
  57385: "f22",
  57386: "f23",
  57387: "f24",
};

const isValidCodepoint = (cp: number): boolean =>
  cp >= 0 && cp <= 0x10_ffff && !(cp >= 0xd8_00 && cp <= 0xdf_ff);

const safeFromCodePoint = (cp: number): string =>
  isValidCodepoint(cp) ? String.fromCodePoint(cp) : "?";

function resolveEventType(value: number): "press" | "repeat" | "release" {
  if (value === 3) return "release";
  if (value === 2) return "repeat";
  return "press";
}

function parseKittyModifiers(modifiers: number) {
  return {
    ctrl: !!(modifiers & kittyModifiers.ctrl),
    shift: !!(modifiers & kittyModifiers.shift),
    meta: !!(modifiers & kittyModifiers.meta),
    option: !!(modifiers & kittyModifiers.alt),
    super: !!(modifiers & kittyModifiers.super),
    hyper: !!(modifiers & kittyModifiers.hyper),
    capsLock: !!(modifiers & kittyModifiers.capsLock),
    numLock: !!(modifiers & kittyModifiers.numLock),
  };
}

function parseKittyKeypress(sequence: string) {
  const match = kittyKeyRe.exec(sequence);
  if (!match) return null;

  const codepoint = Number.parseInt(match[1], 10);
  const modifiers = match[2] ? Math.max(0, Number.parseInt(match[2], 10) - 1) : 0;
  const eventType = match[3] ? Number.parseInt(match[3], 10) : 1;
  const textField = match[4];

  if (!isValidCodepoint(codepoint)) {
    return null;
  }

  let text: string | undefined;
  if (textField) {
    text = textField
      .split(":")
      .map((cp) => safeFromCodePoint(Number.parseInt(cp, 10)))
      .join("");
  }

  let name: string;
  let isPrintable: boolean;

  if (codepoint === 32) {
    name = "space";
    isPrintable = true;
  } else if (codepoint === 13) {
    name = "return";
    isPrintable = true;
  } else if (kittyCodepointNames[codepoint]) {
    name = kittyCodepointNames[codepoint]!;
    isPrintable = false;
  } else if (codepoint >= 1 && codepoint <= 26) {
    name = String.fromCodePoint(codepoint + 96);
    isPrintable = false;
  } else {
    name = safeFromCodePoint(codepoint).toLowerCase();
    isPrintable = true;
  }

  if (isPrintable && !text) {
    text = safeFromCodePoint(codepoint);
  }

  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence,
    raw: sequence,
    isKittyProtocol: true,
    isPrintable,
    text,
  };
}

function parseKittySpecialKey(sequence: string) {
  const match = kittySpecialKeyRe.exec(sequence);
  if (!match) return null;

  const number = Number.parseInt(match[1], 10);
  const modifiers = Math.max(0, Number.parseInt(match[2], 10) - 1);
  const eventType = Number.parseInt(match[3], 10);
  const terminator = match[4]!;
  const name = terminator === "~"
    ? kittySpecialNumberKeys[number]
    : kittySpecialLetterKeys[terminator];

  if (!name) {
    return null;
  }

  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence,
    raw: sequence,
    isKittyProtocol: true,
    isPrintable: false,
  };
}

export interface ParsedCompatKeypress {
  name: string;
  sequence: string;
  raw?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option?: boolean;
  super?: boolean;
  hyper?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  eventType?: "press" | "repeat" | "release";
  isKittyProtocol?: boolean;
  isPrintable?: boolean;
  text?: string;
  code?: string;
}

export default function parseKeypress(input: Buffer | string = ""): ParsedCompatKeypress {
  let sequence = input;
  let parts: RegExpExecArray | null;

  if (Buffer.isBuffer(sequence)) {
    if (sequence[0] > 127 && sequence[1] === undefined) {
      sequence[0] -= 128;
      sequence = "\x1b" + String(sequence);
    } else {
      sequence = String(sequence);
    }
  } else if (sequence !== undefined && typeof sequence !== "string") {
    sequence = String(sequence);
  } else if (!sequence) {
    sequence = "";
  }

  const kittyResult = parseKittyKeypress(sequence);
  if (kittyResult) {
    return kittyResult;
  }

  const kittySpecialResult = parseKittySpecialKey(sequence);
  if (kittySpecialResult) {
    return kittySpecialResult;
  }

  if (kittyKeyRe.test(sequence)) {
    return {
      name: "",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence,
      raw: sequence,
      isKittyProtocol: true,
      isPrintable: false,
    };
  }

  const key: ParsedCompatKeypress = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence,
    raw: sequence,
  };

  key.sequence = key.sequence || sequence || key.name;

  if (sequence === "\r" || sequence === "\x1b\r") {
    key.raw = undefined;
    key.name = "return";
    key.option = sequence.length === 2;
  } else if (sequence === "\n") {
    key.name = "enter";
  } else if (sequence === "\t") {
    key.name = "tab";
  } else if (sequence === "\b" || sequence === "\x1b\b") {
    key.name = "backspace";
    key.meta = sequence.charAt(0) === "\x1b";
  } else if (sequence === "\x7f" || sequence === "\x1b\x7f") {
    key.name = "delete";
    key.meta = sequence.charAt(0) === "\x1b";
  } else if (sequence === "\x1b" || sequence === "\x1b\x1b") {
    key.name = "escape";
    key.meta = sequence.length === 2;
  } else if (sequence === " " || sequence === "\x1b ") {
    key.name = "space";
    key.meta = sequence.length === 2;
  } else if (sequence.length === 1 && sequence <= "\x1a") {
    key.name = String.fromCharCode(sequence.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (sequence.length === 1 && sequence >= "0" && sequence <= "9") {
    key.name = "number";
  } else if (sequence.length === 1 && sequence >= "a" && sequence <= "z") {
    key.name = sequence;
  } else if (sequence.length === 1 && sequence >= "A" && sequence <= "Z") {
    key.name = sequence.toLowerCase();
    key.shift = true;
  } else if ((parts = metaKeyCodeRe.exec(sequence))) {
    key.meta = true;
    key.shift = /^[A-Z]$/.test(parts[1] ?? "");
  } else if ((parts = fnKeyRe.exec(sequence))) {
    const segs = [...sequence];
    if (segs[0] === "\u001b" && segs[1] === "\u001b") {
      key.option = true;
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter(Boolean)
      .join("");
    const modifier = (Number(parts[3] || parts[5] || 1) - 1);

    key.ctrl = !!(modifier & 4);
    key.meta = !!(modifier & 10);
    key.shift = !!(modifier & 1);
    key.code = code;
    key.name = keyName[code] ?? "";
    key.shift = isShiftKey(code) || key.shift;
    key.ctrl = isCtrlKey(code) || key.ctrl;
  }

  return key;
}
