// Registry of chat platforms (Slack, Telegram). The core never talks to a platform directly;
// it asks the adapter for a "target" (one conversation) and calls these methods on it:
//
//   target.post(agentKey, text)            -> handle   post as that teammate
//   target.edit(handle, agentKey, text)               replace a message (e.g. "on it…")
//   target.sendFile(agentKey, name, buf, title)       upload a file into the conversation
//   target.askApproval(agentKey, id, text)            post Send/Cancel buttons
//   target.finish()                                    clean up (e.g. remove 👀)
//   target.mention                                     prefix that pings Kelvin ('' in DMs)
//   adapter.download(file)                  -> Buffer  fetch a file Kelvin shared
const adapters = {};

export function registerAdapter(name, adapter) {
  adapters[name] = adapter;
}

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`platform "${name}" is not running`);
  return a;
}

export const runningPlatforms = () => Object.keys(adapters);
