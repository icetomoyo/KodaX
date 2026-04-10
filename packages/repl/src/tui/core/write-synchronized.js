import isInCi from 'is-in-ci';

export const bsu = '\u001B[?2026h';
export const esu = '\u001B[?2026l';

export function shouldSynchronize(stream) {
    return 'isTTY' in stream && stream.isTTY === true && !isInCi;
}
