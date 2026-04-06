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
import logUpdate from './internals/log-update.js';
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
    log;
    cursorPosition;
    throttledLog;
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
    resetOutputTracking = () => {
        this.log.reset?.();
        this.lastOutput = '';
        this.lastOutputToRender = '';
        this.lastOutputHeight = 0;
        this.cursorPosition = undefined;
    };
    usesVirtualShellOwnership = (options = {}) => {
        const shellMode = options.shellMode ?? this.shellMode;
        const altScreenActive = options.altScreenActive ?? this.altScreenActive;
        const shellTransitionPhase = options.shellTransitionPhase ?? this.shellTransitionPhase;
        return altScreenActive
            || shellMode === 'virtual'
            || shellTransitionPhase !== undefined;
    };
    beginShellTransition(phase) {
        this.shellTransitionPhase = phase;
        this.resetOutputTracking();
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
        const usesVirtualFullscreenShell = this.usesVirtualShellOwnership();
        const shouldUseFullscreenFrameOwnership = this.options.stdout.isTTY
            && outputHeight >= this.options.stdout.rows
            && usesVirtualFullscreenShell;
        const outputToRender = shouldUseFullscreenFrameOwnership ? output : output + '\n';
        if (this.lastOutputHeight >= this.options.stdout.rows && usesVirtualFullscreenShell) {
            const sync = shouldSynchronize(this.options.stdout);
            if (sync) {
                this.options.stdout.write(bsu);
            }
            const fullFrameOutput = this.fullStaticOutput + outputToRender;
            if (this.altScreenActive) {
                this.log.clear();
                this.log(fullFrameOutput);
            }
            else if (this.shellMode === 'main-screen') {
                this.log(fullFrameOutput);
            }
            else {
                this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
                this.log.sync(outputToRender);
            }
            this.lastOutput = output;
            this.lastOutputToRender = this.altScreenActive
                ? fullFrameOutput
                : outputToRender;
            this.lastOutputHeight = outputHeight;
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
            this.log.clear();
            this.options.stdout.write(staticOutput);
            this.log(outputToRender);
            if (sync) {
                this.options.stdout.write(esu);
            }
        }
        else if (output !== this.lastOutput || this.log.isCursorDirty()) {
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
        const throttledLog = this.throttledLog;
        settleThrottle(throttledLog);
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
            else if (!this.options.debug) {
                this.log.done();
            }
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
            this.log.clear();
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
