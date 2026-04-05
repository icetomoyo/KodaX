// @ts-nocheck
import process from 'node:process';
import React from 'react';
import { throttle } from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import { LegacyRoot, ConcurrentRoot } from 'react-reconciler/constants.js';
import Yoga from 'yoga-layout';
import wrapAnsi from 'wrap-ansi';
import terminalSize from 'terminal-size';
import { isDev } from './utils.js';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import logUpdate from './log-update.js';
import { bsu, esu, shouldSynchronize } from './write-synchronized.js';
import instances from './instances.js';
import App from './components/App.js';
import { accessibilityContext as AccessibilityContext } from './components/AccessibilityContext.js';
import { resolveFlags, } from './kitty-keyboard.js';
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
    /**
    Whether this instance is using concurrent rendering mode.
    */
    isConcurrent;
    options;
    log;
    cursorPosition;
    throttledLog;
    isScreenReaderEnabled;
    // Ignore last render after unmounting a tree to prevent empty output before exit
    isUnmounted;
    isUnmounting;
    lastOutput;
    lastOutputToRender;
    lastOutputHeight;
    lastTerminalWidth;
    container;
    rootNode;
    // This variable is used only in debug mode to store full static output
    // so that it's rerendered every time, not just new static parts, like in non-debug mode
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
        this.log = logUpdate.create(options.stdout, {
            incremental: options.incrementalRendering,
        });
        this.cursorPosition = undefined;
        this.throttledLog = unthrottled
            ? this.log
            : throttle((output) => {
                const shouldWrite = this.log.willRender(output);
                const sync = shouldSynchronize(this.options.stdout);
                if (sync && shouldWrite) {
                    this.options.stdout.write(bsu);
                }
                this.log(output);
                if (sync && shouldWrite) {
                    this.options.stdout.write(esu);
                }
            }, undefined, {
                leading: true,
                trailing: true,
            });
        // Ignore last render after unmounting a tree to prevent empty output before exit
        this.isUnmounted = false;
        this.isUnmounting = false;
        // Store concurrent mode setting
        this.isConcurrent = options.concurrent ?? false;
        // Store last output to only rerender when needed
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.lastTerminalWidth = this.getTerminalWidth();
        // This variable is used only in debug mode to store full static output
        // so that it's rerendered every time, not just new static parts, like in non-debug mode
        this.fullStaticOutput = '';
        // Use ConcurrentRoot for concurrent mode, LegacyRoot for legacy mode
        const rootTag = options.concurrent ? ConcurrentRoot : LegacyRoot;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.container = reconciler.createContainer(this.rootNode, rootTag, null, false, null, 'id', () => { }, () => { }, () => { }, () => { });
        // Unmount when process exits
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (isDev()) {
            // @ts-expect-error outdated types
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
        // The 'columns' property can be undefined or 0 when not using a TTY.
        // Use terminal-size as a fallback for piped processes, then default to 80.
        if (this.options.stdout.columns) {
            return this.options.stdout.columns;
        }
        const size = terminalSize();
        return size?.columns ?? 80;
    };
    resized = () => {
        const currentWidth = this.getTerminalWidth();
        if (currentWidth < this.lastTerminalWidth) {
            // We clear the screen when decreasing terminal width to prevent duplicate overlapping re-renders.
            this.log.clear();
            this.lastOutput = '';
            this.lastOutputToRender = '';
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
        this.cursorPosition = position;
        this.log.setCursorPosition(position);
    };
    restoreLastOutput = () => {
        // Clear() resets log-update's cursor state, so replay the latest cursor intent
        // before restoring output after external stdout/stderr writes.
        this.log.setCursorPosition(this.cursorPosition);
        this.log(this.lastOutputToRender || this.lastOutput + '\n');
    };
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
        const startTime = performance.now();
        const { output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled);
        this.options.onRender?.({ renderTime: performance.now() - startTime });
        // If <Static> output isn't empty, it means new children have been added to it
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
                // We need to erase the main output before writing new static output
                const erase = this.lastOutputHeight > 0
                    ? ansiEscapes.eraseLines(this.lastOutputHeight)
                    : '';
                this.options.stdout.write(erase + staticOutput);
                // After erasing, the last output is gone, so we should reset its height
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
            // If we haven't erased yet, do it now.
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
        // Detect fullscreen: output fills or exceeds terminal height.
        // Only apply when writing to a real TTY â€?piped output always gets trailing newlines.
        const isFullscreen = this.options.stdout.isTTY && outputHeight >= this.options.stdout.rows;
        const outputToRender = isFullscreen ? output : output + '\n';
        if (this.lastOutputHeight >= this.options.stdout.rows) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            this.lastOutput = output;
            this.lastOutputToRender = outputToRender;
            this.lastOutputHeight = outputHeight;
            this.log.sync(outputToRender);
            if (sync) {
                this.options.stdout.write(esu);
            }
            return;
        }
        // To ensure static output is cleanly rendered before main output, clear main output first
        if (hasStaticOutput) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            this.log.clear();
            this.options.stdout.write(staticOutput);
            this.log(outputToRender);
            if (sync) {
                this.options.stdout.write(esu);
            }
        }
        else if (output !== this.lastOutput || this.log.isCursorDirty()) {
            // ThrottledLog manages its own bsu/esu at actual write time
            this.throttledLog(outputToRender);
        }
        this.lastOutput = output;
        this.lastOutputToRender = outputToRender;
        this.lastOutputHeight = outputHeight;
    };
    render(node) {
        const tree = (React.createElement(AccessibilityContext.Provider, { value: { isScreenReaderEnabled: this.isScreenReaderEnabled } },
            React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, exitOnCtrlC: this.options.exitOnCtrlC, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, setCursorPosition: this.setCursorPosition, onExit: this.handleAppExit }, node)));
        if (this.options.concurrent) {
            // Concurrent mode: use updateContainer (async scheduling)
            reconciler.updateContainer(tree, this.container, null, noop);
        }
        else {
            // Legacy mode: use updateContainerSync + flushSyncWork (sync)
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
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.options.stdout.write(bsu);
        }
        this.log.clear();
        this.options.stdout.write(data);
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
        const sync = shouldSynchronize(this.options.stdout);
        if (sync) {
            this.options.stdout.write(bsu);
        }
        this.log.clear();
        this.options.stderr.write(data);
        this.restoreLastOutput();
        if (sync) {
            this.options.stdout.write(esu);
        }
    }
    // eslint-disable-next-line @typescript-eslint/ban-types
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
        // Clear any pending throttled render timer on unmount. When stdout is writable,
        // flush so the final frame is emitted; otherwise cancel to avoid delayed callbacks.
        settleThrottle(this.throttledOnRender ?? {});
        if (canWriteToStdout) {
            // If throttling is enabled and there is already a pending render, flushing above
            // is sufficient. Also avoid calling onRender() again when static output already
            // exists, as that can duplicate <Static> children output on exit (see issue #397).
            const shouldRenderFinalFrame = !this.throttledOnRender ||
                (!this.hasPendingThrottledRender && this.fullStaticOutput === '');
            if (shouldRenderFinalFrame) {
                this.calculateLayout();
                this.onRender();
            }
        }
        // Mark as unmounted after the final render but before stdout writes
        // that could re-enter exit() via synchronous write callbacks.
        this.isUnmounted = true;
        this.unsubscribeExit();
        if (typeof this.restoreConsole === 'function') {
            this.restoreConsole();
        }
        if (typeof this.unsubscribeResize === 'function') {
            this.unsubscribeResize();
        }
        // Cancel any in-progress auto-detection before checking protocol state
        if (this.cancelKittyDetection) {
            this.cancelKittyDetection();
        }
        // Flush any pending throttled log writes if possible, otherwise cancel to
        // prevent delayed callbacks from writing to a closed stream.
        const throttledLog = this.throttledLog;
        settleThrottle(throttledLog);
        if (canWriteToStdout) {
            if (this.kittyProtocolEnabled) {
                try {
                    this.options.stdout.write('\u001B[<u');
                }
                catch {
                    // Best-effort: stdout may already be destroyed during shutdown
                }
            }
            // CIs don't handle erasing ansi escapes well, so it's better to
            // only render last frame of non-static output
            if (isInCi) {
                this.options.stdout.write(this.lastOutput + '\n');
            }
            else if (!this.options.debug) {
                this.log.done();
            }
        }
        this.kittyProtocolEnabled = false;
        if (this.options.concurrent) {
            // Concurrent mode: use updateContainer (async scheduling)
            reconciler.updateContainer(null, this.container, null, noop);
        }
        else {
            // Legacy mode: use updateContainerSync + flushSyncWork (sync)
            reconciler.updateContainerSync(null, this.container, null, noop);
            reconciler.flushSyncWork();
        }
        instances.delete(this.options.stdout);
        // Ensure all queued writes have been processed before resolving the
        // exit promise. For real writable streams, queue an empty write as a
        // barrier â€?its callback fires only after all prior writes complete.
        // For non-stream objects (e.g. test spies), resolve on next tick.
        //
        // When called from signal-exit during process shutdown (error is a
        // number or null rather than undefined/Error), resolve synchronously
        // because the event loop is draining and async callbacks won't fire.
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
            this.log.clear();
            // Sync lastOutput so that unmount's final onRender
            // sees it as unchanged and log-update skips it
            this.log.sync(this.lastOutputToRender || this.lastOutput + '\n');
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
        // Protocol is opt-in: if kittyKeyboard is not specified, do nothing
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
        // Auto mode: use heuristic precheck, then confirm with protocol query
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
            // Re-emit any buffered data that wasn't the protocol response,
            // so it isn't lost from Ink's normal input pipeline.
            // Clear responseBuffer afterwards to make cleanup idempotent.
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
        // Attach listener before writing the query so that synchronous
        // or immediate responses are not missed.
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
