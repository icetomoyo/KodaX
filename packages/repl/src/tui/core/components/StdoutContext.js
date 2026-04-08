import { createContext } from 'react';

const fallbackStdout = {
    isTTY: false,
    columns: 80,
    rows: 24,
    write() { return true; },
    on() { },
    off() { },
};

const StdoutContext = createContext({
    stdout: fallbackStdout,
    write() { },
});

StdoutContext.displayName = 'InternalStdoutContext';

export default StdoutContext;
