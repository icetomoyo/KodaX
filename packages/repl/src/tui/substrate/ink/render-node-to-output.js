import widestLine from 'widest-line';
import indentString from 'indent-string';
import Yoga from 'yoga-layout';
import wrapText from './wrap-text.js';
import getMaxWidth from './get-max-width.js';
import squashTextNodes from './squash-text-nodes.js';
import renderBorder from './render-border.js';
import renderBackground from './render-background.js';
// If parent container is `<Box>`, text nodes will be treated as separate nodes in
// the tree and will have their own coordinates in the layout.
// To ensure text nodes are aligned correctly, take X and Y of the first text node
// and use it as offset for the rest of the nodes
// Only first node is taken into account, because other text nodes can't have margin or padding,
// so their coordinates will be relative to the first node anyway
const applyPaddingToText = (node, text) => {
    const yogaNode = node.childNodes[0]?.yogaNode;
    if (yogaNode) {
        const offsetX = yogaNode.getComputedLeft();
        const offsetY = yogaNode.getComputedTop();
        text = '\n'.repeat(offsetY) + indentString(text, offsetX);
    }
    return text;
};
export const renderNodeToScreenReaderOutput = (node, options = {}) => {
    if (options.skipStaticElements && node.internal_static) {
        return '';
    }
    if (node.yogaNode?.getDisplay() === Yoga.DISPLAY_NONE) {
        return '';
    }
    let output = '';
    if (node.nodeName === 'ink-text') {
        output = squashTextNodes(node);
    }
    else if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
        const separator = node.style.flexDirection === 'row' ||
            node.style.flexDirection === 'row-reverse'
            ? ' '
            : '\n';
        const childNodes = node.style.flexDirection === 'row-reverse' ||
            node.style.flexDirection === 'column-reverse'
            ? [...node.childNodes].reverse()
            : [...node.childNodes];
        output = childNodes
            .map(childNode => {
            const screenReaderOutput = renderNodeToScreenReaderOutput(childNode, {
                parentRole: node.internal_accessibility?.role,
                skipStaticElements: options.skipStaticElements,
            });
            return screenReaderOutput;
        })
            .filter(Boolean)
            .join(separator);
    }
    if (node.internal_accessibility) {
        const { role, state } = node.internal_accessibility;
        if (state) {
            const stateKeys = Object.keys(state);
            const stateDescription = stateKeys.filter(key => state[key]).join(', ');
            if (stateDescription) {
                output = `(${stateDescription}) ${output}`;
            }
        }
        if (role && role !== options.parentRole) {
            output = `${role}: ${output}`;
        }
    }
    return output;
};
// After nodes are laid out, render each to output object, which later gets rendered to terminal
const renderNodeToOutput = (node, output, options) => {
    const { offsetX = 0, offsetY = 0, transformers = [], skipStaticElements, } = options;
    if (skipStaticElements && node.internal_static) {
        return;
    }
    const { yogaNode } = node;
    if (yogaNode) {
        if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
            return;
        }
        // Left and top positions in Yoga are relative to their parent node
        const x = offsetX + yogaNode.getComputedLeft();
        const y = offsetY + yogaNode.getComputedTop();
        // Transformers are functions that transform final text output of each component
        // See Output class for logic that applies transformers
        let newTransformers = transformers;
        if (typeof node.internal_transform === 'function') {
            newTransformers = [node.internal_transform, ...transformers];
        }
        if (node.nodeName === 'ink-text') {
            let text = squashTextNodes(node);
            if (text.length > 0) {
                const currentWidth = widestLine(text);
                const maxWidth = getMaxWidth(yogaNode);
                if (currentWidth > maxWidth) {
                    const textWrap = node.style.textWrap ?? 'wrap';
                    text = wrapText(text, maxWidth, textWrap);
                }
                text = applyPaddingToText(node, text);
                output.write(x, y, text, { transformers: newTransformers });
            }
            return;
        }
        let clipped = false;
        let scrollOffsetY = 0;
        if (node.nodeName === 'ink-box') {
            renderBackground(x, y, node, output);
            renderBorder(x, y, node, output);
            const overflowX = node.style.overflowX ?? node.style.overflow;
            const overflowY = node.style.overflowY ?? node.style.overflow;
            const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll';
            const clipVertically = overflowY === 'hidden' || overflowY === 'scroll';
            if (overflowY === 'scroll') {
                const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
                const borderBottom = yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
                const viewportHeight = Math.max(0, yogaNode.getComputedHeight() - borderTop - borderBottom);
                const virtualScrollWindowed = node.attributes?.virtualScrollWindowed === true;
                const contentNode = node.childNodes[0];
                const contentHeight = Math.max(0, Math.floor(virtualScrollWindowed
                    ? node.attributes?.scrollHeight ?? 0
                    : contentNode?.yogaNode?.getComputedHeight() ?? node.attributes?.scrollHeight ?? 0));
                const previousScrollHeight = typeof node.scrollHeight === 'number'
                    ? node.scrollHeight
                    : contentHeight;
                const rawScrollTop = node.scrollTop ?? node.attributes?.scrollTop ?? 0;
                const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
                const stickyScroll = node.stickyScroll ?? Boolean(node.attributes?.stickyScroll);
                const clampMin = node.attributes?.scrollClampMin;
                const clampMax = node.attributes?.scrollClampMax;
                const normalizedScrollTop = Math.max(0, Math.min(Math.floor(rawScrollTop), maxScrollTop));
                const shouldFollowBottom = stickyScroll && contentHeight >= previousScrollHeight;
                const logicalScrollTop = shouldFollowBottom
                    ? maxScrollTop
                    : normalizedScrollTop;
                const clampedViewportTop = clampMin !== undefined || clampMax !== undefined
                    ? Math.max(clampMin ?? 0, Math.min(logicalScrollTop, Math.min(maxScrollTop, clampMax ?? maxScrollTop)))
                    : logicalScrollTop;
                node.scrollHeight = contentHeight;
                node.scrollViewportHeight = viewportHeight;
                node.scrollViewportTop = clampedViewportTop;
                node.scrollTop = clampedViewportTop;
                if (!virtualScrollWindowed) {
                    scrollOffsetY = clampedViewportTop;
                }
            }
            if (clipHorizontally || clipVertically) {
                const x1 = clipHorizontally
                    ? x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT)
                    : undefined;
                const x2 = clipHorizontally
                    ? x +
                        yogaNode.getComputedWidth() -
                        yogaNode.getComputedBorder(Yoga.EDGE_RIGHT)
                    : undefined;
                const y1 = clipVertically
                    ? y + yogaNode.getComputedBorder(Yoga.EDGE_TOP)
                    : undefined;
                const y2 = clipVertically
                    ? y +
                        yogaNode.getComputedHeight() -
                        yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM)
                    : undefined;
                output.clip({ x1, x2, y1, y2 });
                clipped = true;
            }
        }
        if (node.nodeName === 'ink-root' || node.nodeName === 'ink-box') {
            for (const childNode of node.childNodes) {
                renderNodeToOutput(childNode, output, {
                    offsetX: x,
                    offsetY: y - scrollOffsetY,
                    transformers: newTransformers,
                    skipStaticElements,
                });
            }
            if (clipped) {
                output.unclip();
            }
        }
    }
};
export default renderNodeToOutput;
