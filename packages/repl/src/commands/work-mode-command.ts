import type { Command } from './types.js';

/** One Session selector; /mode remains the independent permission control. */
export const workModeCommand: Command = {
  name: 'work-mode', description: 'Select Agent, Coding or Script for this idle Session',
  usage: '/work-mode [agent|coding|script]',
  handler: async (args, _context, callbacks, current) => {
    if (!args.length) return { success: true,
      message: `Work mode: ${current.hostSettings ? current.hostSettings.workMode ?? 'coding' : current.workMode ?? 'coding'}\nChoices: agent, coding (default), script. Permissions and AMA strategy are unchanged.` };
    const mode = args[0]?.toLowerCase();
    if (args.length !== 1 || (mode !== 'agent' && mode !== 'coding' && mode !== 'script')) {
      return { success: false, message: 'Usage: /work-mode [agent|coding|script]' };
    }
    if (!callbacks.setWorkMode) return { success: false, message: 'Session work mode control unavailable.' };
    try {
      await callbacks.setWorkMode(mode);
      return { success: true, message: `Work mode: ${mode}. Applied to this Session; other Sessions and saved defaults are unchanged.` };
    } catch (error) { return { success: false, message: `Work mode was not changed: ${String(error)}` }; }
  },
};
