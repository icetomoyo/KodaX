import React from 'react';
/**
Declaratively position the terminal cursor relative to a container.

Use this component when building reusable inputs where absolute root coordinates are inconvenient.

`<Cursor>` must not be rendered inside `<Text>`.

@example
```jsx
import {Box, Cursor, Text} from '../index.js';
import {useRef} from 'react';

const prompt = '> ';
const value = 'hello';

const Example = () => {
    return (
        <Box flexDirection="row">
            <Text>{prompt}</Text>
            <Text>{value}</Text>
            <Cursor />
        </Box>
    );
};
```

```jsx
const ExampleWithAnchor = () => {
    const lineReference = useRef();

    return (
        <Box flexDirection="column">
            <Box ref={lineReference}>
                <Text>{`${prompt}${value}`}</Text>
            </Box>
            <Cursor anchorRef={lineReference} />
        </Box>
    );
};
```
*/
export default function Cursor({ anchorRef, anchor, x = 0, y = 0 }) {
    const normalizedAnchorReference = anchorRef ?? undefined;
    const normalizedAnchor = anchor ?? (normalizedAnchorReference ? 'textEnd' : 'flow');
    return (React.createElement("ink-cursor", { internal_cursor: {
            anchorRef: normalizedAnchorReference,
            anchor: normalizedAnchor,
            x,
            y,
        } }));
}
