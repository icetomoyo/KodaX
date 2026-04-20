/**
 * KodaX MCP Elicitation Handler
 *
 * Bridges MCP server elicitation requests to the user via ask_user_question.
 */

export interface ElicitationRequest {
  readonly message: string;
  readonly requestId: string;
  readonly schema?: Record<string, unknown>;
}

export interface ElicitationResponse {
  readonly requestId: string;
  readonly response: string;
  readonly cancelled?: boolean;
}

export type UserPromptFn = (question: string) => Promise<string | null>;

/**
 * Handle an MCP elicitation request by prompting the user.
 */
export async function handleElicitation(
  request: ElicitationRequest,
  askUser: UserPromptFn,
): Promise<ElicitationResponse> {
  const prompt = request.schema
    ? `${request.message}\n(Expected format: ${JSON.stringify(request.schema)})`
    : request.message;

  const userResponse = await askUser(prompt);

  if (userResponse === null) {
    return {
      requestId: request.requestId,
      response: '',
      cancelled: true,
    };
  }

  return {
    requestId: request.requestId,
    response: userResponse,
  };
}

/**
 * Format an elicitation request for display.
 */
export function formatElicitationPrompt(request: ElicitationRequest): string {
  const lines = [`[MCP Server Request] ${request.message}`];
  if (request.schema) {
    lines.push(`Expected format: ${JSON.stringify(request.schema, null, 2)}`);
  }
  return lines.join('\n');
}
