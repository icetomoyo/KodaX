export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const HOME_CURSOR = "\x1b[H";
export const CLEAR_SCREEN = "\x1b[2J";
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";

export interface AlternateScreenSequenceOptions {
  mouseTracking?: boolean;
  clearOnEnter?: boolean;
}

export function buildAlternateScreenEnterSequence(
  options: AlternateScreenSequenceOptions = {},
): string {
  const mouseTracking = options.mouseTracking !== false;
  const clearOnEnter = options.clearOnEnter === true;
  return (
    ENTER_ALT_SCREEN
    + (clearOnEnter ? CLEAR_SCREEN : "")
    + HOME_CURSOR
    + (mouseTracking ? ENABLE_MOUSE_TRACKING : "")
  );
}

export function buildAlternateScreenExitSequence(
  options: Pick<AlternateScreenSequenceOptions, "mouseTracking"> = {},
): string {
  const mouseTracking = options.mouseTracking !== false;
  return (mouseTracking ? DISABLE_MOUSE_TRACKING : "") + EXIT_ALT_SCREEN;
}
