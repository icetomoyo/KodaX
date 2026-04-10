import { EventEmitter } from 'node:events';
import process from 'node:process';
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import cliCursor from 'cli-cursor';
import { createInputParser } from '../input-parser.js';
import AppContext from './AppContext.js';
import StdinContext from './StdinContext.js';
import StdoutContext from './StdoutContext.js';
import StderrContext from './StderrContext.js';
import FocusContext from './FocusContext.js';
import CursorContext from './CursorContext.js';
import ErrorBoundary from './ErrorBoundary.js';

const tab = '\t';
const shiftTab = '\u001B[Z';
const escape = '\u001B';

function App({ children, stdin, stdout, stderr, writeToStdout, writeToStderr, exitOnCtrlC, onExit, setCursorPosition }) {
    const [isFocusEnabled, setIsFocusEnabled] = useState(true);
    const [activeFocusId, setActiveFocusId] = useState(undefined);
    const [, setFocusables] = useState([]);
    const focusablesCountRef = useRef(0);
    const rawModeEnabledCount = useRef(0);
    const internal_eventEmitter = useRef(new EventEmitter());
    internal_eventEmitter.current.setMaxListeners(Infinity);
    const readableListenerRef = useRef(undefined);
    const inputParserRef = useRef(createInputParser());
    const pendingInputFlushRef = useRef(undefined);

    const clearPendingInputFlush = useCallback(() => {
        if (!pendingInputFlushRef.current) {
            return;
        }
        clearImmediate(pendingInputFlushRef.current);
        pendingInputFlushRef.current = undefined;
    }, []);

    const isRawModeSupported = stdin.isTTY;

    const detachReadableListener = useCallback(() => {
        if (!readableListenerRef.current) {
            return;
        }
        stdin.removeListener('readable', readableListenerRef.current);
        readableListenerRef.current = undefined;
    }, [stdin]);

    const disableRawMode = useCallback(() => {
        stdin.setRawMode(false);
        detachReadableListener();
        stdin.unref();
        rawModeEnabledCount.current = 0;
        inputParserRef.current.reset();
        clearPendingInputFlush();
    }, [stdin, detachReadableListener, clearPendingInputFlush]);

    const handleExit = useCallback((errorOrResult) => {
        if (isRawModeSupported && rawModeEnabledCount.current > 0) {
            disableRawMode();
        }
        onExit(errorOrResult);
    }, [isRawModeSupported, disableRawMode, onExit]);

    const handleInput = useCallback((input) => {
        if (input === '\x03' && exitOnCtrlC) {
            handleExit();
            return;
        }
        if (input === escape) {
            setActiveFocusId(currentActiveFocusId => currentActiveFocusId ? undefined : currentActiveFocusId);
        }
    }, [exitOnCtrlC, handleExit]);

    const emitInput = useCallback((input) => {
        handleInput(input);
        internal_eventEmitter.current.emit('input', input);
    }, [handleInput]);

    const schedulePendingInputFlush = useCallback(() => {
        clearPendingInputFlush();
        pendingInputFlushRef.current = setImmediate(() => {
            pendingInputFlushRef.current = undefined;
            const pendingEscape = inputParserRef.current.flushPendingEscape();
            if (!pendingEscape) {
                return;
            }
            emitInput(pendingEscape);
        });
    }, [clearPendingInputFlush, emitInput]);

    const handleReadable = useCallback(() => {
        clearPendingInputFlush();
        let chunk;
        while ((chunk = stdin.read()) !== null) {
            const inputEvents = inputParserRef.current.push(chunk);
            for (const input of inputEvents) {
                emitInput(input);
            }
        }
        if (inputParserRef.current.hasPendingEscape()) {
            schedulePendingInputFlush();
        }
    }, [stdin, emitInput, clearPendingInputFlush, schedulePendingInputFlush]);

    const handleSetRawMode = useCallback((isEnabled) => {
        if (!isRawModeSupported) {
            if (stdin === process.stdin) {
                throw new Error('Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
            }
            throw new Error('Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
        }

        stdin.setEncoding('utf8');
        if (isEnabled) {
            if (rawModeEnabledCount.current === 0) {
                stdin.ref();
                stdin.setRawMode(true);
                readableListenerRef.current = handleReadable;
                stdin.addListener('readable', handleReadable);
            }
            rawModeEnabledCount.current++;
            return;
        }

        if (rawModeEnabledCount.current === 0) {
            return;
        }
        if (--rawModeEnabledCount.current === 0) {
            disableRawMode();
        }
    }, [isRawModeSupported, stdin, handleReadable, disableRawMode]);

    const findNextFocusable = useCallback((currentFocusables, currentActiveFocusId) => {
        const activeIndex = currentFocusables.findIndex(focusable => focusable.id === currentActiveFocusId);
        for (let index = activeIndex + 1; index < currentFocusables.length; index++) {
            const focusable = currentFocusables[index];
            if (focusable?.isActive) {
                return focusable.id;
            }
        }
        return undefined;
    }, []);

    const findPreviousFocusable = useCallback((currentFocusables, currentActiveFocusId) => {
        const activeIndex = currentFocusables.findIndex(focusable => focusable.id === currentActiveFocusId);
        for (let index = activeIndex - 1; index >= 0; index--) {
            const focusable = currentFocusables[index];
            if (focusable?.isActive) {
                return focusable.id;
            }
        }
        return undefined;
    }, []);

    const focusNext = useCallback(() => {
        setFocusables(currentFocusables => {
            setActiveFocusId(currentActiveFocusId => {
                const firstFocusableId = currentFocusables.find(focusable => focusable.isActive)?.id;
                const nextFocusableId = findNextFocusable(currentFocusables, currentActiveFocusId);
                return nextFocusableId ?? firstFocusableId;
            });
            return currentFocusables;
        });
    }, [findNextFocusable]);

    const focusPrevious = useCallback(() => {
        setFocusables(currentFocusables => {
            setActiveFocusId(currentActiveFocusId => {
                const lastFocusableId = currentFocusables.findLast(focusable => focusable.isActive)?.id;
                const previousFocusableId = findPreviousFocusable(currentFocusables, currentActiveFocusId);
                return previousFocusableId ?? lastFocusableId;
            });
            return currentFocusables;
        });
    }, [findPreviousFocusable]);

    useEffect(() => {
        const handleTabNavigation = (input) => {
            if (!isFocusEnabled || focusablesCountRef.current === 0) {
                return;
            }
            if (input === tab) {
                focusNext();
            }
            if (input === shiftTab) {
                focusPrevious();
            }
        };

        internal_eventEmitter.current.on('input', handleTabNavigation);
        const emitter = internal_eventEmitter.current;
        return () => {
            emitter.off('input', handleTabNavigation);
        };
    }, [isFocusEnabled, focusNext, focusPrevious]);

    const enableFocus = useCallback(() => {
        setIsFocusEnabled(true);
    }, []);

    const disableFocus = useCallback(() => {
        setIsFocusEnabled(false);
    }, []);

    const focus = useCallback((id) => {
        setFocusables(currentFocusables => {
            const hasFocusableId = currentFocusables.some(focusable => focusable?.id === id);
            if (hasFocusableId) {
                setActiveFocusId(id);
            }
            return currentFocusables;
        });
    }, []);

    const addFocusable = useCallback((id, { autoFocus }) => {
        setFocusables(currentFocusables => {
            focusablesCountRef.current = currentFocusables.length + 1;
            return [...currentFocusables, { id, isActive: true }];
        });
        if (autoFocus) {
            setActiveFocusId(currentActiveFocusId => currentActiveFocusId ?? id);
        }
    }, []);

    const removeFocusable = useCallback((id) => {
        setActiveFocusId(currentActiveFocusId => currentActiveFocusId === id ? undefined : currentActiveFocusId);
        setFocusables(currentFocusables => {
            const filtered = currentFocusables.filter(focusable => focusable.id !== id);
            focusablesCountRef.current = filtered.length;
            return filtered;
        });
    }, []);

    const activateFocusable = useCallback((id) => {
        setFocusables(currentFocusables => currentFocusables.map(focusable => {
            if (focusable.id !== id) {
                return focusable;
            }
            return { id, isActive: true };
        }));
    }, []);

    const deactivateFocusable = useCallback((id) => {
        setActiveFocusId(currentActiveFocusId => currentActiveFocusId === id ? undefined : currentActiveFocusId);
        setFocusables(currentFocusables => currentFocusables.map(focusable => {
            if (focusable.id !== id) {
                return focusable;
            }
            return { id, isActive: false };
        }));
    }, []);

    useEffect(() => {
        return () => {
            cliCursor.show(stdout);
            if (isRawModeSupported && rawModeEnabledCount.current > 0) {
                disableRawMode();
            }
        };
    }, [stdout, isRawModeSupported, disableRawMode]);

    const appContextValue = useMemo(() => ({ exit: handleExit }), [handleExit]);
    const stdinContextValue = useMemo(() => ({
        stdin,
        setRawMode: handleSetRawMode,
        isRawModeSupported,
        internal_exitOnCtrlC: exitOnCtrlC,
        internal_eventEmitter: internal_eventEmitter.current,
    }), [stdin, handleSetRawMode, isRawModeSupported, exitOnCtrlC]);
    const stdoutContextValue = useMemo(() => ({ stdout, write: writeToStdout }), [stdout, writeToStdout]);
    const stderrContextValue = useMemo(() => ({ stderr, write: writeToStderr }), [stderr, writeToStderr]);
    const cursorContextValue = useMemo(() => ({ setCursorPosition }), [setCursorPosition]);
    const focusContextValue = useMemo(() => ({
        activeId: activeFocusId,
        add: addFocusable,
        remove: removeFocusable,
        activate: activateFocusable,
        deactivate: deactivateFocusable,
        enableFocus,
        disableFocus,
        focusNext,
        focusPrevious,
        focus,
    }), [
        activeFocusId,
        addFocusable,
        removeFocusable,
        activateFocusable,
        deactivateFocusable,
        enableFocus,
        disableFocus,
        focusNext,
        focusPrevious,
        focus,
    ]);

    return React.createElement(
        AppContext.Provider,
        { value: appContextValue },
        React.createElement(
            StdinContext.Provider,
            { value: stdinContextValue },
            React.createElement(
                StdoutContext.Provider,
                { value: stdoutContextValue },
                React.createElement(
                    StderrContext.Provider,
                    { value: stderrContextValue },
                    React.createElement(
                        FocusContext.Provider,
                        { value: focusContextValue },
                        React.createElement(
                            CursorContext.Provider,
                            { value: cursorContextValue },
                            React.createElement(ErrorBoundary, { onError: handleExit }, children),
                        ),
                    ),
                ),
            ),
        ),
    );
}

App.displayName = 'InternalApp';

export default App;
