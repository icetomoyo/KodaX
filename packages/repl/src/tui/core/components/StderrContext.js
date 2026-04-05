import process from 'node:process';
import { createContext } from 'react';

const StderrContext = createContext({
    stderr: process.stderr,
    write() { },
});

StderrContext.displayName = 'InternalStderrContext';

export default StderrContext;
