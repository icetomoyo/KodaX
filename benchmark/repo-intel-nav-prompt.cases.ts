/**
 * Cases for the RepoIntel v2 navigation prompt eval (benchmark/repo-intel-nav-prompt.eval.ts).
 * Every input is a real first request from the managed Runtime with the Host's v2 engine bound to the Run,
 * on a committed snapshot of packages/agent. The candidate arm is that request. The baseline arm is the same
 * request without the find_symbol and file_outline tools and without the Repository Map section: what a Run
 * gets with no engine. N1-N4 compare the two arms. N5 and N6 continue after a find_symbol result, so only the
 * candidate arm has them and they are judged on their own.
 * Questions and the review rubric are pre-registered here, before any provider call.
 */

export interface NavTask { readonly id: string; readonly task: string }

/** Root tasks captured once each through the managed Runtime. */
export const TASKS: readonly NavTask[] = [
  { id: 'callers', task: 'I am going to give emitKodaXDiagnostic a second `source` argument. List every call site I will need to update.' },
  { id: 'envvar', task: 'Where do we read the KODAX_HOME environment variable, and what happens when it is set to a relative path?' },
  { id: 'outline', task: 'I need to add a public method to the actor controller in packages/agent/src/actors/controller.ts. Show me how that file is organized so I know where the method should go.' },
  { id: 'scope', task: 'I want to add a third scope for memory notes, next to user and project. Which code would I have to change?' },
  { id: 'tokens', task: 'Find every caller of estimateTokens, the one that counts the tokens of a message list.' },
];

/** A find_symbol call the model already made, and the result the candidate arm answers. */
export interface Continuation {
  readonly input: Readonly<Record<string, unknown>>;
  /** indexing: the not-ready answer from the tool's own code. engine: the real engine's answer, taken at capture. */
  readonly result: 'indexing' | 'engine';
}

export interface NavCase {
  readonly id: 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6';
  readonly task: NavTask['id'];
  readonly continuation?: Continuation;
  readonly question: string;
  readonly rubric: string;
}

export const CASES: readonly NavCase[] = [
  {
    id: 'N1', task: 'callers',
    question: 'Symbol navigation. The user names a function and wants every call site. Does the candidate use find_symbol with references, and does that serve the request at least as well as the baseline\'s grep?',
    rubric: 'Better: find_symbol with name emitKodaXDiagnostic and references true (optionally with the defining path). Equal: grep for the name, or both. Worse: an opening that cannot list call sites, or file_outline/reads of guessed files instead of a search. Harm: answering with call sites before any search.',
  },
  {
    id: 'N2', task: 'envvar',
    question: 'Guard. The user asks about an environment variable, which is a string in the code, not a symbol name. Does the candidate still search the text with grep, rather than spending a call on find_symbol for KODAX_HOME?',
    rubric: 'Expected on both arms: grep for KODAX_HOME (or a read of a file the run context points to). Worse: find_symbol on KODAX_HOME as the only search, which finds nothing because the variable is a string literal. Neutral: find_symbol alongside grep in the same response.',
  },
  {
    id: 'N3', task: 'outline',
    question: 'A 3,400-line file the user names. Does the candidate learn the file\'s organization with file_outline instead of reading the file whole or in blind slices?',
    rubric: 'Better: file_outline on packages/agent/src/actors/controller.ts, possibly with a targeted read after. Equal: grep for class/method declarations in that file. Worse: a read of the whole file or of an arbitrary slice with no structure in hand. Harm: describing the file before seeing it.',
  },
  {
    id: 'N4', task: 'scope',
    question: 'Concept question whose answer the Repository Map hints at (memory-store/record.ts exports NoteScope = \'user\' | \'project\'). Does the candidate go to the right code sooner, without trusting the map as the whole answer?',
    rubric: 'Better: first calls aimed at NoteScope or memory-store/record.ts (find_symbol references on NoteScope, grep for NoteScope, read of record.ts) that will reach the scope\'s uses. Equal: broad grep on scope or memory words. Harm: listing the files to change from the map alone, without reading or searching, or claiming the map lists every place.',
  },
  {
    id: 'N5', task: 'callers', continuation: { input: { name: 'emitKodaXDiagnostic', references: true }, result: 'indexing' },
    question: 'Candidate only. find_symbol answered that the index is still being built. Does the next response fall back to grep/read rather than retrying find_symbol or giving up?',
    rubric: 'Good: grep for emitKodaXDiagnostic (or glob/read toward it) in this response. Poor: another find_symbol call, a wait, or asking the user. Harm: reporting call sites without searching, or treating the empty answer as no callers.',
  },
  {
    id: 'N6', task: 'tokens', continuation: { input: { name: 'estimateTokens', references: true }, result: 'engine' },
    question: 'Candidate only. find_symbol said estimateTokens is defined in more than one file and listed name-only matches. Does the next response resolve the ambiguity, by calling again with the defining path of the message-list estimateTokens, or by checking the name-only matches?',
    rubric: 'Good: find_symbol with references and the path of the message-list definition (packages/agent/src/tokenizer.ts), or reads/greps that separate the two definitions\' callers. Poor: repeating the same call, or another path. Harm: presenting the name-only matches as the callers of the tokenizer.ts function.',
  },
];
