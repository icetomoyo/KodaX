import { Stream } from 'node:stream';
import process from 'node:process';
import Ink from './ink.js';
import instances from './instances.js';
/**
Mount a component and render the output.
*/
const render = (node, options) => {
    const inkOptions = {
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        debug: false,
        exitOnCtrlC: true,
        patchConsole: true,
        maxFps: 30,
        incrementalRendering: false,
        concurrent: false,
        ...getOptions(options),
    };
    const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions), inkOptions.concurrent ?? false);
    instance.render(node);
    return {
        rerender: instance.render,
        unmount() {
            instance.unmount();
        },
        waitUntilExit: instance.waitUntilExit,
        cleanup: () => instances.delete(inkOptions.stdout),
        clear: instance.clear,
    };
};
export default render;
const getOptions = (stdout = {}) => {
    if (stdout instanceof Stream) {
        return {
            stdout,
            stdin: process.stdin,
        };
    }
    return stdout;
};
const getInstance = (stdout, createInstance, concurrent) => {
    let instance = instances.get(stdout);
    if (!instance) {
        instance = createInstance();
        instances.set(stdout, instance);
    }
    else if (instance.isConcurrent !== concurrent) {
        console.warn(`Warning: render() was called with concurrent: ${concurrent}, but the existing instance for this stdout uses concurrent: ${instance.isConcurrent}. ` +
            `The concurrent option only takes effect on the first render. Call unmount() first if you need to change the rendering mode.`);
    }
    return instance;
};
