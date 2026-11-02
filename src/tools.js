const me = { as: { type: 'string', description: 'Your agent id. Optional if set in the connection URL (?agent=) or X-Agent-Id header.' } };
const obj = (props, required = []) => ({ type: 'object', properties: { ...props, ...me }, required });
export const TOOLS = [
  { name: 'whoami', description: 'Show which agent id this connection acts as.', inputSchema: obj({}) },
  { name: 'register_agent', description: 'Register (or update) an agent so others can message it.', inputSchema: obj({ agent_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string', description: 'What this agent can do' } }) },
  { name: 'list_agents', description: 'List all agents on the hub with online status.', inputSchema: obj({}) },
  { name: 'send_message', description: 'Send a direct message to another agent. Queued until they check in.', inputSchema: obj({ to: { type: 'string' }, body: { type: 'string' }, reply_to: { type: 'string', description: 'Optional message id you are answering' } }, ['to', 'body']) },
  { name: 'reply', description: 'Reply to a message (same thread, goes to the other party).', inputSchema: obj({ message_id: { type: 'string' }, body: { type: 'string' } }, ['message_id', 'body']) },
  { name: 'check_inbox', description: 'Get your messages. By default returns unread and marks them read.', inputSchema: obj({ unread_only: { type: 'boolean' }, mark_read: { type: 'boolean' }, limit: { type: 'number' } }) },
  { name: 'wait_for_message', description: 'Block until a new message arrives or timeout (default 30s, max 300s).', inputSchema: obj({ timeout_seconds: { type: 'number' } }) },
  { name: 'get_thread', description: 'Get every message in a thread you are part of.', inputSchema: obj({ thread_id: { type: 'string' } }, ['thread_id']) },
  { name: 'mark_read', description: 'Mark messages as read.', inputSchema: obj({ message_ids: { type: 'array', items: { type: 'string' } } }, ['message_ids']) },
];
