import process from 'node:process';
import { createContext } from 'react';

const StdoutContext = createContext({
    stdout: process.stdout,
    write() { },
});

StdoutContext.displayName = 'InternalStdoutContext';

export default StdoutContext;
