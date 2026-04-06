import { EventEmitter } from 'node:events';
import { createContext } from 'react';

const fallbackStdin = {
    isTTY: false,
    isRaw: false,
    on() { },
    off() { },
    pause() { },
    resume() { },
    setRawMode() { },
};

const StdinContext = createContext({
    stdin: fallbackStdin,
    internal_eventEmitter: new EventEmitter(),
    setRawMode() { },
    isRawModeSupported: false,
    internal_exitOnCtrlC: true,
});

StdinContext.displayName = 'InternalStdinContext';

export default StdinContext;
