/** Experimental wire ablation only; does not change the production prompt builder. */
export function moveVisualMethodToSystem(request: Record<string, unknown>, method: string): Record<string, unknown> {
  if (!method.trim() || !Array.isArray(request.messages) || !Array.isArray(request.tools)) {
    throw new Error('Frozen method, messages and tools required.');
  }
  const next = structuredClone(request);
  const messages = next.messages as { role: string; content: unknown }[];
  const tools = next.tools as { function?: { name?: string; description?: string } }[];
  const systems = messages.filter(message => message.role === 'system');
  const inspections = tools.filter(tool => tool.function?.name === 'visual_inspect');
  const system = systems[0];
  const inspect = inspections[0]?.function;
  if (systems.length !== 1 || typeof system?.content !== 'string' || inspections.length !== 1
    || !inspect?.description?.startsWith(`${method} `) || JSON.stringify(request).split(method).length !== 2) {
    throw new Error('Frozen single method occurrence and injection targets required.');
  }
  inspect.description = inspect.description.slice(method.length + 1);
  system.content = `${system.content}\n\n${method}`;
  return next;
}
