// @ts-nocheck
import process from 'node:process';
import React from 'react';
import { throttle } from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import { onExit as signalExit } from 'signal-exit';
import patchConsole from 'patch-console';
import { LegacyRoot, ConcurrentRoot } from 'react-reconciler/constants.js';
import Yoga from 'yoga-layout';
import wrapAnsi from 'wrap-ansi';
import terminalSize from 'terminal-size';
import { isDev } from './utils.js';
import reconciler from './internals/reconciler.js';
import render from './internals/renderer.js';
import * as dom from './internals/dom.js';
import { LogUpdate as CellLogUpdate } from '../substrate/ink/cell-renderer.js';
import { applyCellFrame as applyCellFrameHelper } from '../substrate/ink/apply-cell-frame.js';
import { applyDiff } from '../substrate/ink/apply-diff.js';
import { emptyFrame } from '../substrate/ink/frame.js';
import { bsu, esu, shouldSynchronize } from './write-synchronized.js';
import instances from './instances.js';
import App from './components/App.js';
import { accessibilityContext as AccessibilityContext } from './contexts/AccessibilityContext.js';
import { resolveFlags } from './kitty-keyboard.js';

const noop = () => { };
const kittyQueryEscapeByte = 0x1b;
const kittyQueryOpenBracketByte = 0x5b;
const kittyQueryQuestionMarkByte = 0x3f;
const kittyQueryLetterByte = 0x75;
const zeroByte = 0x30;
const nineByte = 0x39;
const isDigitByte = (byte) => byte >= zeroByte && byte <= nineByte;

const matchKittyQueryResponse = (buffer, startIndex) => {
    if (buffer[startIndex] !== kittyQueryEscapeByte ||
        buffer[startIndex + 1] !== kittyQueryOpenBracketByte ||
        buffer[startIndex + 2] !== kittyQueryQuestionMarkByte) {
        return undefined;
    }
    let index = startIndex + 3;
    const digitsStartIndex = index;
    while (index < buffer.length && isDigitByte(buffer[index])) {
        index++;
    }
    if (index === digitsStartIndex) {
        return undefined;
    }
    if (index === buffer.length) {
        return { state: 'partial' };
    }
    if (buffer[index] === kittyQueryLetterByte) {
        return { state: 'complete', endIndex: index };
    }
    return undefined;
};

const hasCompleteKittyQueryResponse = (buffer) => {
    for (let index = 0; index < buffer.length; index++) {
        const match = matchKittyQueryResponse(buffer, index);
        if (match?.state === 'complete') {
            return true;
        }
    }
    return false;
};

const stripKittyQueryResponsesAndTrailingPartial = (buffer) => {
    const keptBytes = [];
    let index = 0;
    while (index < buffer.length) {
        const match = matchKittyQueryResponse(buffer, index);
        if (match?.state === 'complete') {
            index = match.endIndex + 1;
            continue;
        }
        if (match?.state === 'partial') {
            break;
        }
        keptBytes.push(buffer[index]);
        index++;
    }
    return keptBytes;
};

const isErrorInput = (value) => {
    return (value instanceof Error ||
        Object.prototype.toString.call(value) === '[object Error]');
};

/**
 * @typedef {{
 *   isConcurrent: boolean;
 *   render: (node: import('react').ReactNode) => void;
 *   unmount: (error?: unknown) => void;
 *   waitUntilExit: () => Promise<unknown>;
 *   clear: () => void;
 * }} InkPublicInstance
 */
/** @type {new (options: any) => InkPublicInstance} */
const Ink = class Ink {
    isConcurrent;
    options;
    cursorPosition;
    isScreenReaderEnabled;
    isUnmounted;
    isUnmounting;
    lastOutput;
    lastOutputToRender;
    lastOutputHeight;
    lastTerminalWidth;
    container;
    rootNode;
    fullStaticOutput;
    exitPromise;
    exitResult;
    beforeExitHandler;
    restoreConsole;
    unsubscribeResize;
    throttledOnRender;
    hasPendingThrottledRender = false;
    kittyProtocolEnabled = false;
    cancelKittyDetection;
    altScreenActive = false;
    shellMode;
    mouseTrackingActive = false;
    shellTransitionPhase = undefined;
    cursorHidden = false;
    constructor(options) {
        autoBind(this);
        this.options = options;
        this.rootNode = dom.createNode('ink-root');
        this.rootNode.onComputeLayout = this.calculateLayout;
        this.isScreenReaderEnabled =
            options.isScreenReaderEnabled ??
                process.env['INK_SCREEN_READER'] === 'true';
        const unthrottled = options.debug || this.isScreenReaderEnabled;
        const maxFps = options.maxFps ?? 30;
        const renderThrottleMs = maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
        if (unthrottled) {
            this.rootNode.onRender = this.onRender;
            this.throttledOnRender = undefined;
        }
        else {
            const throttled = throttle(this.onRender, renderThrottleMs, {
                leading: true,
                trailing: true,
            });
            this.rootNode.onRender = () => {
                this.hasPendingThrottledRender = true;
                throttled();
            };
            this.throttledOnRender = throttled;
        }
        this.rootNode.onImmediateRender = this.onRender;
        // FEATURE_057 Track F Phase 6 (v0.7.30): cell-level renderer is the
        // sole render path. `applyCellFrame(frame)` owns every dispatch in
        // `onRender()` (debug / CI / screen-reader branches still bypass
        // cell renderer for compatibility — those have specialized output
        // pipelines that don't benefit from cell-level diffing).
        this.cellLogUpdate = new CellLogUpdate({
            isTTY: Boolean(options.stdout.isTTY),
        });
        this.prevFrame = emptyFrame(
            options.stdout.rows ?? 24,
            options.stdout.columns ?? 80,
        );
        this.cursorPosition = undefined;
        this.isUnmounted = false;
        this.isUnmounting = false;
        this.isConcurrent = options.concurrent ?? false;
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.lastTerminalWidth = this.getTerminalWidth();
        this.fullStaticOutput = '';
        this.shellMode = options.shellMode ?? 'virtual';
        const rootTag = options.concurrent ? ConcurrentRoot : LegacyRoot;
        this.container = reconciler.createContainer(this.rootNode, rootTag, null, false, null, 'id', () => { }, () => { }, () => { }, () => { });
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (isDev()) {
            reconciler.injectIntoDevTools();
        }
        if (options.patchConsole) {
            this.patchConsole();
        }
        if (!isInCi) {
            options.stdout.on('resize', this.resized);
            this.unsubscribeResize = () => {
                options.stdout.off('resize', this.resized);
            };
        }
        this.initKittyKeyboard();
    }
    getTerminalWidth = () => {
        if (this.options.stdout.columns) {
            return this.options.stdout.columns;
        }
        const size = terminalSize();
        return size?.columns ?? 80;
    };
    resized = () => {
        const currentWidth = this.getTerminalWidth();
        if (currentWidth < this.lastTerminalWidth) {
            // Phase 6: width shrink — clear visible render area + reseed cell
            // renderer's prevFrame so the next applyCellFrame paints from
            // scratch. `shouldFullReset` Case 1 also catches viewport-shrink /
            // width-change on the next render's own merits, but the explicit
            // erase-on-shrink keeps the screen clean across the resize.
            const eraseSeq = this.lastOutputHeight > 0
                ? ansiEscapes.eraseLines(this.lastOutputHeight)
                : '';
            if (eraseSeq.length > 0) {
                this.options.stdout.write(eraseSeq);
            }
            this.lastOutput = '';
            this.lastOutputToRender = '';
            this.cellLogUpdate.reset();
            this.prevFrame = emptyFrame(this.options.stdout.rows ?? 24, currentWidth);
        }
        this.calculateLayout();
        this.onRender();
        this.lastTerminalWidth = currentWidth;
    };
    resolveExitPromise = () => { };
    rejectExitPromise = () => { };
    unsubscribeExit = () => { };
    handleAppExit = (errorOrResult) => {
        if (this.isUnmounted || this.isUnmounting) {
            return;
        }
        if (isErrorInput(errorOrResult)) {
            this.unmount(errorOrResult);
            return;
        }
        this.exitResult = errorOrResult;
        this.unmount();
    };
    setCursorPosition = (position) => {
        // Phase 6 (v0.7.30): cell renderer derives terminal cursor placement
        // from `frame.cursor` (set by renderer.js to (0, screen.height)) on
        // every dispatch; today the legacy log-update IME-positioning path is
        // not re-applied (custom `TextInput` owns its own visible cursor via
        // inverse-color cell). The state is preserved here for any future
        // renderer-level IME wiring.
        //
        // Defensive clamp: if a future call site reapplies `cursorPosition`
        // through `cellLogUpdate.render` or `applyDiff`, an out-of-bounds
        // (x, y) would hit `setCellAt`'s RangeError and crash the process.
        // Clamp into [0, width-1] × [0, height-1] at the storage boundary so
        // the stored value can always be safely consumed downstream.
        if (position === undefined) {
            this.cursorPosition = undefined;
            return;
        }
        const cols = this.getTerminalWidth();
        const rows = this.options.stdout.rows ?? 24;
        // width / height of zero (very edge cases — TTY just resized away)
        // would make any non-undefined position out-of-bounds; drop to
        // undefined rather than store a guaranteed-broken coordinate.
        if (cols <= 0 || rows <= 0) {
            this.cursorPosition = undefined;
            return;
        }
        const x = Math.max(0, Math.min(position.x | 0, cols - 1));
        const y = Math.max(0, Math.min(position.y | 0, rows - 1));
        this.cursorPosition = { x, y };
    };
    resetOutputTracking = () => {
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.cursorPosition = undefined;
        // Phase 6: callers (`setShellMode` / `setAltScreenActive`) invoke this
        // when the substrate cursor pipeline has just emitted alt-screen
        // toggles or mouse-tracking flips outside the cell-renderer pipeline.
        // The actual screen state is now decoupled from `prevFrame`, so the
        // next `applyCellFrame` must paint from scratch — otherwise its diff
        // computes against a stale `prevFrame` and leaves rows un-repainted.
        this.invalidateCellFrame();
    };
    usesVirtualShellOwnership = (options = {}) => {
        const altScreenActive = options.altScreenActive ?? this.altScreenActive;
        return altScreenActive;
    };
    beginShellTransition(phase) {
        this.shellTransitionPhase = phase;
    }
    setShellMode(mode, mouseTracking) {
        const previousMode = this.shellMode;
        const previousMouseTracking = this.mouseTrackingActive;
        const previousVirtualOwnership = this.usesVirtualShellOwnership();
        const nextMouseTracking = mouseTracking ?? false;
        this.shellMode = mode;
        this.mouseTrackingActive = nextMouseTracking;
        const nextVirtualOwnership = this.usesVirtualShellOwnership();
        const shellOwnershipChanged = previousMode !== mode
            && (previousVirtualOwnership || nextVirtualOwnership);
        const managedMouseTrackingChanged = previousMouseTracking !== nextMouseTracking
            && nextVirtualOwnership;
        if (shellOwnershipChanged || managedMouseTrackingChanged) {
            this.resetOutputTracking();
        }
    }
    setAltScreenActive(active, mouseTracking) {
        const previousAltScreenActive = this.altScreenActive;
        const previousMouseTracking = this.mouseTrackingActive;
        const previousVirtualOwnership = this.usesVirtualShellOwnership();
        const nextMouseTracking = mouseTracking ?? false;
        this.altScreenActive = active;
        this.mouseTrackingActive = nextMouseTracking;
        this.shellTransitionPhase = undefined;
        const nextVirtualOwnership = this.usesVirtualShellOwnership();
        const altScreenChanged = previousAltScreenActive !== active;
        const managedMouseTrackingChanged = previousMouseTracking !== nextMouseTracking
            && (previousVirtualOwnership || nextVirtualOwnership);
        if (altScreenChanged || managedMouseTrackingChanged) {
            this.resetOutputTracking();
        }
    }
    clearTextSelection() {
    }
    restoreLastOutput = () => {
        // Phase 6: replay the last cell-level frame at the current cursor
        // position. Used after `writeToStdout` / `writeToStderr` injects
        // external bytes above the rendered UI — we erase the rendered
        // area, write the external data, then paint the prev frame back
        // below it via a cell-renderer diff against an empty seed. The
        // diff's first-render-via-incremental path paints all rows with
        // row-final `\r\n`, landing the cursor at (0, prevFrame.screen.height).
        if (this.prevFrame.screen.height === 0) return;
        const empty = emptyFrame(
            this.options.stdout.rows ?? 24,
            this.getTerminalWidth(),
        );
        const diff = this.cellLogUpdate.render(empty, this.prevFrame);
        applyDiff(this.options.stdout, diff);
    };
    shouldRestoreManagedShellAfterExternalWrite = () => this.altScreenActive;
    calculateLayout = () => {
        const terminalWidth = this.getTerminalWidth();
        this.rootNode.yogaNode.setWidth(terminalWidth);
        this.rootNode.yogaNode.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    };
    onRender = () => {
        this.hasPendingThrottledRender = false;
        if (this.isUnmounted) {
            return;
        }
        // Phase 6 cursor visibility: legacy `log-update.js`'s `createStandard`
        // called `cliCursor.hide(stream)` on the first render when `showCursor`
        // was unset (the engine never set it, so this fired by default). The
        // cell renderer doesn't emit `cursorHide` patches automatically — the
        // OS terminal cursor would otherwise blink at the bottom-left of the
        // rendered UI (the post-render cursor lands at `(0, screen.height)`).
        // Emit a one-time `\x1b[?25l` here, paired with `App.js`'s useEffect
        // cleanup that calls `cliCursor.show(stdout)` on unmount. Skip in CI
        // / debug / screen-reader modes — those paths bypass the cell renderer
        // entirely and don't render an interactive UI that would benefit from
        // cursor hiding.
        if (!this.cursorHidden
            && !isInCi
            && !this.options.debug
            && !this.isScreenReaderEnabled) {
            this.options.stdout.write('[?25l');
            this.cursorHidden = true;
        }
        const startTime = performance.now();
        // Phase 6: pass terminalSize so renderer.js can build `frame.viewport`
        // from the real TTY dimensions (Phase 3b's scrollback decisions need
        // the visible viewport, not the rendered content size).
        const cellTerminalSize = {
            rows: this.options.stdout.rows ?? 24,
            columns: this.getTerminalWidth(),
        };
        const { output, outputHeight, staticOutput, frame } = render(this.rootNode, this.isScreenReaderEnabled, cellTerminalSize);
        this.options.onRender?.({ renderTime: performance.now() - startTime });
        const hasStaticOutput = staticOutput && staticOutput !== '\n';
        if (this.options.debug) {
            if (hasStaticOutput) {
                this.fullStaticOutput += staticOutput;
            }
            this.options.stdout.write(this.fullStaticOutput + output);
            return;
        }
        if (isInCi) {
            if (hasStaticOutput) {
                this.options.stdout.write(staticOutput);
            }
            this.lastOutput = output;
            this.lastOutputToRender = output + '\n';
            this.lastOutputHeight = outputHeight;
            return;
        }
        if (this.isScreenReaderEnabled) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            if (hasStaticOutput) {
                const erase = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.options.stdout.write(erase + staticOutput);
                this.lastOutputHeight = 0;
            }
            if (output === this.lastOutput && !hasStaticOutput) {
                if (sync) {
                    this.options.stdout.write(esu);
                }
                return;
            }
            const terminalWidth = this.getTerminalWidth();
            const wrappedOutput = wrapAnsi(output, terminalWidth, {
                trim: false,
                hard: true,
            });
            if (hasStaticOutput) {
                this.options.stdout.write(wrappedOutput);
            }
            else {
                const erase = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.options.stdout.write(erase + wrappedOutput);
            }
            this.lastOutput = output;
            this.lastOutputToRender = wrappedOutput;
            this.lastOutputHeight =
                wrappedOutput === '' ? 0 : wrappedOutput.split('\n').length;
            if (sync) {
                this.options.stdout.write(esu);
            }
            return;
        }
        if (hasStaticOutput) {
            this.fullStaticOutput += staticOutput;
        }
        const usesManagedVirtualFullscreenShell = this.altScreenActive;
        const shouldUseFullscreenFrameOwnership = this.options.stdout.isTTY
            && outputHeight >= this.options.stdout.rows
            && usesManagedVirtualFullscreenShell;
        const outputToRender = shouldUseFullscreenFrameOwnership ? output : output + '\n';
        if (this.lastOutputHeight >= this.options.stdout.rows && usesManagedVirtualFullscreenShell) {
            // Phase 6 fullscreen branch: previous render filled or exceeded
            // the viewport. We need to clear the visible area + repaint with
            // the new full-frame content. Cell renderer's `shouldFullReset`
            // Case 3 covers the "scrollback cell change" subset; the
            // explicit branch here also handles the "viewport-filling
            // re-render with no scrollback cell change" case (e.g.,
            // toggling between two same-shape full screens — the diff would
            // be incremental but we still want clearAndRender atomicity for
            // Win10 OpenSSH/ConPTY where two-write erase+paint flickers).
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            const fullFrameOutput = this.fullStaticOutput + outputToRender;
            if (this.altScreenActive) {
                // Single atomic stream.write to avoid the FEATURE_096
                // Win10/ConPTY two-write blank intermediate frame.
                const eraseSeq = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.options.stdout.write(eraseSeq + fullFrameOutput);
            }
            else {
                this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            }
            this.lastOutput = output;
            this.lastOutputToRender = this.altScreenActive
                ? fullFrameOutput
                : outputToRender;
            this.lastOutputHeight = outputHeight;
            // Reseed the cell renderer's prevFrame so the next applyCellFrame
            // goes through the full-frame paint path — we just wrote string
            // content to stdout outside the cell-renderer pipeline.
            this.invalidateCellFrame();
            if (sync) {
                this.options.stdout.write(esu);
            }
            return;
        }
        if (hasStaticOutput) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            // Phase 6: erase main render area, write the new <Static> block
            // (which scrolls up into terminal scrollback), then paint the
            // main render via the cell renderer. invalidateCellFrame()
            // before applyCellFrame so the cell path treats this as a
            // first-render at the current cursor position (post-static).
            const eraseSeq = this.lastOutputHeight > 0
                ? ansiEscapes.eraseLines(this.lastOutputHeight)
                : '';
            this.options.stdout.write(eraseSeq + staticOutput);
            this.invalidateCellFrame();
            this.applyCellFrame(frame);
            if (sync) {
                this.options.stdout.write(esu);
            }
        }
        else {
            // Phase 6: cell renderer is the sole render path. Returns true
            // when the cell path consumed the frame; with `frame` always
            // populated post-Phase-6 (renderer.js gate is now unconditional
            // for non-screen-reader paths), the call always succeeds.
            this.applyCellFrame(frame);
        }
        this.lastOutput = output;
        this.lastOutputToRender = outputToRender;
        this.lastOutputHeight = outputHeight;
    };
    /**
     * Apply a cell-level Frame to the terminal. Returns `true` when the
     * cell path consumed the frame, `false` when it didn't (frame was
     * undefined — only happens on the screen-reader path).
     */
    applyCellFrame = (frame) => {
        const state = {
            cellLogUpdate: this.cellLogUpdate,
            prevFrame: this.prevFrame,
            stdout: this.options.stdout,
        };
        const applied = applyCellFrameHelper(state, frame);
        this.prevFrame = state.prevFrame;
        return applied;
    };
    /**
     * Invalidate the cell renderer's `prevFrame`. Called whenever a write
     * to stdout outside the cell-renderer pipeline (writeToStdout /
     * writeToStderr / clear() / fullscreen branch's raw write) leaves
     * `prevFrame` out of sync with the actual screen state. Reseeding
     * with `emptyFrame` forces the next `applyCellFrame` through the
     * first-render-via-incremental path, painting from scratch.
     */
    invalidateCellFrame = () => {
        this.cellLogUpdate.reset();
        this.prevFrame = emptyFrame(
            this.options.stdout.rows ?? 24,
            this.getTerminalWidth(),
        );
    };
    render(node) {
        const tree = (React.createElement(AccessibilityContext.Provider, { value: { isScreenReaderEnabled: this.isScreenReaderEnabled } },
            React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, exitOnCtrlC: this.options.exitOnCtrlC, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, setCursorPosition: this.setCursorPosition, onExit: this.handleAppExit }, node)));
        if (this.options.concurrent) {
            reconciler.updateContainer(tree, this.container, null, noop);
        }
        else {
            reconciler.updateContainerSync(tree, this.container, null, noop);
            reconciler.flushSyncWork();
        }
    }
    writeToStdout(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stdout.write(data);
            return;
        }
        if (!this.shouldRestoreManagedShellAfterExternalWrite()) {
            this.options.stdout.write(data);
            // Raw stdout write bypasses the cell-renderer pipeline; the
            // next applyCellFrame must repaint from a clean slate.
            this.invalidateCellFrame();
            return;
        }
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.options.stdout.write(bsu);
        }
        // Phase 6: erase the rendered UI area, write the external `data`
        // (which lands above the UI in scrollback / scroll history), then
        // replay the last cell frame at the new cursor position via
        // `restoreLastOutput`. After the replay the cell renderer's
        // prevFrame is in sync with the screen — no invalidation needed.
        const eraseSeq = this.lastOutputHeight > 0
            ? ansiEscapes.eraseLines(this.lastOutputHeight)
            : '';
        this.options.stdout.write(eraseSeq + data);
        this.restoreLastOutput();
        if (sync) {
            this.options.stdout.write(esu);
        }
    }
    writeToStderr(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stderr.write(data);
            this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stderr.write(data);
            return;
        }
        if (!this.shouldRestoreManagedShellAfterExternalWrite()) {
            this.options.stderr.write(data);
            // Raw stderr write bypasses the cell-renderer pipeline.
            this.invalidateCellFrame();
            return;
        }
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.options.stdout.write(bsu);
        }
        // Phase 6: erase rendered UI on stdout, write `data` to stderr,
        // replay last cell frame on stdout. The erase + write needs two
        // separate streams (stdout for erase, stderr for data), so it's
        // inherently a two-write sequence — cell-renderer atomicity does
        // not apply across stream boundaries.
        const eraseSeq = this.lastOutputHeight > 0
            ? ansiEscapes.eraseLines(this.lastOutputHeight)
            : '';
        if (eraseSeq.length > 0) {
            this.options.stdout.write(eraseSeq);
        }
        this.options.stderr.write(data);
        this.restoreLastOutput();
        if (sync) {
            this.options.stdout.write(esu);
        }
    }
    unmount(error) {
        if (this.isUnmounted || this.isUnmounting) {
            return;
        }
        this.isUnmounting = true;
        if (this.beforeExitHandler) {
            process.off('beforeExit', this.beforeExitHandler);
            this.beforeExitHandler = undefined;
        }
        const stdout = this.options.stdout;
        const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
        const settleThrottle = (throttled) => {
            if (typeof throttled.flush !== 'function') {
                return;
            }
            if (canWriteToStdout) {
                throttled.flush();
            }
            else if (typeof throttled.cancel === 'function') {
                throttled.cancel();
            }
        };
        settleThrottle(this.throttledOnRender ?? {});
        if (canWriteToStdout) {
            const shouldRenderFinalFrame = !this.throttledOnRender ||
                (!this.hasPendingThrottledRender && this.fullStaticOutput === '');
            if (shouldRenderFinalFrame) {
                this.calculateLayout();
                this.onRender();
            }
        }
        this.isUnmounted = true;
        this.unsubscribeExit();
        if (typeof this.restoreConsole === 'function') {
            this.restoreConsole();
        }
        if (typeof this.unsubscribeResize === 'function') {
            this.unsubscribeResize();
        }
        if (this.cancelKittyDetection) {
            this.cancelKittyDetection();
        }
        if (canWriteToStdout) {
            if (this.kittyProtocolEnabled) {
                try {
                    this.options.stdout.write('\u001B[<u');
                }
                catch {
                }
            }
            if (isInCi) {
                this.options.stdout.write(this.lastOutput + '\n');
            }
            // Phase 6: no `this.log.done()` cleanup needed — cell renderer
            // is stateless at the stream level. The cursor visibility
            // restore that legacy `done()` performed via cliCursor.show
            // is handled by the substrate cursor pipeline + alt-screen
            // cleanup at the higher renderer-runtime / runtime layers.
        }
        this.kittyProtocolEnabled = false;
        this.shellTransitionPhase = undefined;
        if (this.options.concurrent) {
            reconciler.updateContainer(null, this.container, null, noop);
        }
        else {
            reconciler.updateContainerSync(null, this.container, null, noop);
            reconciler.flushSyncWork();
        }
        instances.delete(this.options.stdout);
        const { exitResult } = this;
        const resolveOrReject = () => {
            if (isErrorInput(error)) {
                this.rejectExitPromise(error);
            }
            else {
                this.resolveExitPromise(exitResult);
            }
        };
        const isProcessExiting = error !== undefined && !isErrorInput(error);
        const hasWritableState = stdout._writableState !== undefined ||
            stdout.writableLength !== undefined;
        if (isProcessExiting) {
            resolveOrReject();
        }
        else if (canWriteToStdout && hasWritableState) {
            this.options.stdout.write('', resolveOrReject);
        }
        else {
            setImmediate(resolveOrReject);
        }
    }
    async waitUntilExit() {
        this.exitPromise ||= new Promise((resolve, reject) => {
            this.resolveExitPromise = resolve;
            this.rejectExitPromise = reject;
        });
        if (!this.beforeExitHandler) {
            this.beforeExitHandler = () => {
                this.unmount();
            };
            process.once('beforeExit', this.beforeExitHandler);
        }
        return this.exitPromise;
    }
    clear() {
        if (!isInCi && !this.options.debug) {
            // Phase 6: erase the visible render area; reseed cell renderer's
            // prevFrame so the next applyCellFrame paints from scratch.
            const eraseSeq = this.lastOutputHeight > 0
                ? ansiEscapes.eraseLines(this.lastOutputHeight)
                : '';
            if (eraseSeq.length > 0) {
                this.options.stdout.write(eraseSeq);
            }
            this.invalidateCellFrame();
        }
    }
    patchConsole() {
        if (this.options.debug) {
            return;
        }
        this.restoreConsole = patchConsole((stream, data) => {
            if (stream === 'stdout') {
                this.writeToStdout(data);
            }
            if (stream === 'stderr') {
                const isReactMessage = data.startsWith('The above error occurred');
                if (!isReactMessage) {
                    this.writeToStderr(data);
                }
            }
        });
    }
    initKittyKeyboard() {
        if (!this.options.kittyKeyboard) {
            return;
        }
        const opts = this.options.kittyKeyboard;
        const mode = opts.mode ?? 'auto';
        if (mode === 'disabled' ||
            !this.options.stdin.isTTY ||
            !this.options.stdout.isTTY) {
            return;
        }
        const flags = opts.flags ?? ['disambiguateEscapeCodes'];
        if (mode === 'enabled') {
            this.enableKittyProtocol(flags);
            return;
        }
        const term = process.env['TERM'] ?? '';
        const termProgram = process.env['TERM_PROGRAM'] ?? '';
        const isKnownSupportingTerminal = 'KITTY_WINDOW_ID' in process.env ||
            term === 'xterm-kitty' ||
            termProgram === 'WezTerm' ||
            termProgram === 'ghostty';
        if (!isInCi && isKnownSupportingTerminal) {
            this.confirmKittySupport(flags);
        }
    }
    confirmKittySupport(flags) {
        const { stdin, stdout } = this.options;
        let responseBuffer = [];
        const cleanup = () => {
            this.cancelKittyDetection = undefined;
            clearTimeout(timer);
            stdin.removeListener('data', onData);
            const remaining = stripKittyQueryResponsesAndTrailingPartial(responseBuffer);
            responseBuffer = [];
            if (remaining.length > 0) {
                stdin.unshift(Buffer.from(remaining));
            }
        };
        const onData = (data) => {
            const chunk = typeof data === 'string' ? Buffer.from(data) : data;
            for (const byte of chunk) {
                responseBuffer.push(byte);
            }
            if (hasCompleteKittyQueryResponse(responseBuffer)) {
                cleanup();
                if (!this.isUnmounted) {
                    this.enableKittyProtocol(flags);
                }
            }
        };
        stdin.on('data', onData);
        const timer = setTimeout(cleanup, 200);
        this.cancelKittyDetection = cleanup;
        stdout.write('\u001B[?u');
    }
    enableKittyProtocol(flags) {
        this.options.stdout.write(`\u001B[>${resolveFlags(flags)}u`);
        this.kittyProtocolEnabled = true;
    }
};

export default Ink;
