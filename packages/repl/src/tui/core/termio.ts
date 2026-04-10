export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const HOME_CURSOR = "\x1b[H";
export const CLEAR_SCREEN = "\x1b[2J";
// Mouse tracking:
// - 1000: press/release + wheel
// - 1002: button-motion drag events
// - 1006: SGR coordinates
//
// We intentionally stop at 1002 for now. Claude also enables 1003 all-motion
// for hover, but KodaX does not yet expose a renderer-native hover path that
// can distinguish passive motion from drag safely.
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

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
