import { createContext } from 'react';

const fallbackStderr = {
    isTTY: false,
    write() { return true; },
    on() { },
    off() { },
};

const StderrContext = createContext({
    stderr: fallbackStderr,
    write() { },
});

StderrContext.displayName = 'InternalStderrContext';

export default StderrContext;
