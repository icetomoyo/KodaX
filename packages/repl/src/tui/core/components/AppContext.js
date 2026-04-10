import { createContext } from 'react';

const AppContext = createContext({
    exit() { },
});

AppContext.displayName = 'InternalAppContext';

export default AppContext;
