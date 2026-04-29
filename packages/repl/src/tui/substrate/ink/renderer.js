import renderNodeToOutput, { renderNodeToScreenReaderOutput, } from './render-node-to-output.js';
import Output from './output.js';
import { outputToScreen } from './output-to-screen.js';
/**
 * @param {object} node - the rendered ink DOM node
 * @param {boolean} isScreenReaderEnabled - whether the screen-reader pipeline is active
 * @param {{rows: number, columns: number}} [terminalSize] - actual TTY
 *   dimensions used for `frame.viewport`. Falls back to the yoga-computed content
 *   size when undefined; passing the real terminal size lets `LogUpdate`'s
 *   scrollback decisions (Phase 3b `shouldFullReset`) reason against the visible
 *   viewport rather than the rendered content height.
 * @returns {{ output: string, outputHeight: number, staticOutput: string, frame: import('./frame.js').Frame | undefined }}
 *   Phase 6 (v0.7.30): cell renderer is the sole render path. `frame` is
 *   populated for every render except the screen-reader path (which has its
 *   own accessibility projection — no Frame produced). Legacy fields
 *   (`output` / `outputHeight` / `staticOutput`) remain populated for
 *   compatibility with engine.js's legacy bookkeeping (`lastOutput*`).
 */
const renderer = (node, isScreenReaderEnabled, terminalSize) => {
    if (node.yogaNode) {
        if (isScreenReaderEnabled) {
            const output = renderNodeToScreenReaderOutput(node, {
                skipStaticElements: true,
            });
            const outputHeight = output === '' ? 0 : output.split('\n').length;
            let staticOutput = '';
            if (node.staticNode) {
                staticOutput = renderNodeToScreenReaderOutput(node.staticNode, {
                    skipStaticElements: false,
                });
            }
            return {
                output,
                outputHeight,
                staticOutput: staticOutput ? `${staticOutput}\n` : '',
                frame: undefined,
            };
        }
        const output = new Output({
            width: node.yogaNode.getComputedWidth(),
            height: node.yogaNode.getComputedHeight(),
        });
        renderNodeToOutput(node, output, {
            skipStaticElements: true,
        });
        let staticOutput;
        if (node.staticNode?.yogaNode) {
            staticOutput = new Output({
                width: node.staticNode.yogaNode.getComputedWidth(),
                height: node.staticNode.yogaNode.getComputedHeight(),
            });
            renderNodeToOutput(node.staticNode, staticOutput, {
                skipStaticElements: false,
            });
        }
        const { output: generatedOutput, height: outputHeight } = output.get();
        // Phase 6: cell renderer is the sole path. Build a Frame from the
        // same Output as the legacy string output (via outputToScreen calling
        // output.getGrid()) so the cell grid stays consistent for any
        // diagnostic that compares them.
        const screen = outputToScreen(output);
        const viewportWidth = terminalSize?.columns ?? node.yogaNode.getComputedWidth();
        const viewportHeight = terminalSize?.rows ?? node.yogaNode.getComputedHeight();
        const frame = {
            screen,
            viewport: { width: viewportWidth, height: viewportHeight },
            // Cursor lands one row past the last content row so the next
            // render's incremental diff starts from a deterministic
            // position. CC reference behavior (cursor at content bottom).
            cursor: { x: 0, y: screen.height, visible: true },
        };
        return {
            output: generatedOutput,
            outputHeight,
            // Newline at the end is needed, because static output doesn't have one, so
            // interactive output will override last line of static output
            staticOutput: staticOutput ? `${staticOutput.get().output}\n` : '',
            frame,
        };
    }
    return {
        output: '',
        outputHeight: 0,
        staticOutput: '',
        frame: undefined,
    };
};
export default renderer;
