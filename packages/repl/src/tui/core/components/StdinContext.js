import { EventEmitter } from 'node:events';
import process from 'node:process';
import { createContext } from 'react';

const StdinContext = createContext({
    stdin: process.stdin,
    internal_eventEmitter: new EventEmitter(),
    setRawMode() { },
    isRawModeSupported: false,
    internal_exitOnCtrlC: true,
});

StdinContext.displayName = 'InternalStdinContext';

export default StdinContext;
