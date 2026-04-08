import { createContext } from 'react';

const CursorContext = createContext({
    setCursorPosition() { },
});

CursorContext.displayName = 'InternalCursorContext';

export default CursorContext;
