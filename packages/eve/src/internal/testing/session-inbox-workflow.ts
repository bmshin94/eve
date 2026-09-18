import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";

export async function sessionCommandInboxWorkflow(input: {
  readonly messageCount?: number;
  readonly nextToken?: string;
  readonly token: string;
}): Promise<string[]> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const inbox = createSessionInbox(workflowRunId);

  try {
    await inbox.claimSessionHook(sessionCommandHookToken(workflowRunId));
    await inbox.claimSessionHook(input.token);
    const pending = inbox.next();
    if (input.nextToken !== undefined) {
      await inbox.claimSessionHook(input.nextToken);
    }

    const messages: string[] = [];
    let payload = await pending;
    while (true) {
      if (payload === undefined) return messages;
      if (payload.kind === "reset") return messages;
      collectMessage(payload, messages);
      if (messages.length >= (input.messageCount ?? 2)) return messages;
      payload = await inbox.next();
    }
  } finally {
    await inbox.dispose();
  }
}

export async function sessionCallbackGrantInboxWorkflow(): Promise<unknown[]> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const inbox = createSessionInbox(workflowRunId);
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(workflowRunId));
    const callers: unknown[] = [];
    while (callers.length < 2) {
      const next = await inbox.next();
      if (next === undefined) break;
      const delivery = decodeSessionInboxPayload(next);
      if (delivery.kind === "deliver") callers.push(delivery.caller);
    }
    return callers;
  } finally {
    await inbox.dispose();
  }
}

function collectMessage(command: SessionInboxPayload, messages: string[]): void {
  if (command.kind === "send" && typeof command.payload.message === "string") {
    messages.push(command.payload.message);
  }
  if (command.kind === "deliver" && typeof command.payloads[0]?.message === "string") {
    messages.push(command.payloads[0].message);
  }
}
