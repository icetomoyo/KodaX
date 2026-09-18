import { runSessionPicker, type SessionPickerItem, type SessionPickerRunOptions } from './ui/SessionPicker.js';
export { listCliResumeSessions, type ListCliResumeSessionsOptions } from './session/resume-discovery.js';
export async function runCliResumePicker(
  sessions: readonly SessionPickerItem[],
  options: SessionPickerRunOptions = {},
): Promise<SessionPickerItem | undefined> {
  return runSessionPicker(sessions, options);
}

export type {
  SessionPickerItem,
  SessionPickerRunOptions,
} from './ui/SessionPicker.js';
