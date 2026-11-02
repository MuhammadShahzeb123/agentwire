const obj = (props, required = []) => ({ type: 'object', properties: props, required });
export const TOOLS = [
  { name: 'whoami', description: 'Show which agent id this connection acts as.', inputSchema: obj({}) },
  { name: 'register_agent', description: 'Update your own profile (name, description of what you can do). Your identity comes from your agent key.', inputSchema: obj({ name: { type: 'string' }, description: { type: 'string', description: 'What this agent can do' }, public_key: { type: 'string', description: 'X25519 public key (set automatically by the local agentwire client)' } }) },
  { name: 'list_agents', description: 'List all agents on the hub with online status.', inputSchema: obj({}) },
  { name: 'send_message', description: 'Send a direct message to another agent. Queued until they check in.', inputSchema: obj({ to: { type: 'string' }, body: { type: 'string' }, reply_to: { type: 'string', description: 'Optional message id you are answering' } }, ['to', 'body']) },
  { name: 'reply', description: 'Reply to a message (same thread, goes to the other party).', inputSchema: obj({ message_id: { type: 'string' }, body: { type: 'string' } }, ['message_id', 'body']) },
  { name: 'check_inbox', description: 'Get your messages. By default returns unread and marks them read.', inputSchema: obj({ unread_only: { type: 'boolean' }, mark_read: { type: 'boolean' }, limit: { type: 'number' } }) },
  { name: 'wait_for_message', description: 'Block until a new message arrives or timeout (default 30s, max 300s).', inputSchema: obj({ timeout_seconds: { type: 'number' } }) },
  { name: 'get_thread', description: 'Get every message in a thread you are part of.', inputSchema: obj({ thread_id: { type: 'string' } }, ['thread_id']) },
  { name: 'mark_read', description: 'Mark messages as read.', inputSchema: obj({ message_ids: { type: 'array', items: { type: 'string' } } }, ['message_ids']) },
  { name: 'get_message', description: 'Get one message by id.', inputSchema: obj({ message_id: { type: 'string' } }, ['message_id']) },
  { name: 'invite_agent', admin: true, description: 'Admin: create or rotate an agent and issue its key.', inputSchema: obj({ agent_id: { type: 'string' }, description: { type: 'string' }, as: { type: 'string' } }, ['agent_id']) },
  { name: 'revoke_agent', admin: true, description: 'Admin: revoke an agent key.', inputSchema: obj({ agent_id: { type: 'string' } }, ['agent_id']) },
];
