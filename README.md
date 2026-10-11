# Agent Team

A team of Claude agents you text on Slack. You send a task, a manager picks the right agent, the agent works in the background, and you get a ping in the thread when it's done.

```
You (Slack DM / @agents)
   │
   ▼
bot.js ── router.js ──► picks agent (prefix or Haiku)
   │
   ▼
Redis queue (BullMQ)
   │
   ▼
worker.js ── Claude Agent SDK ──► 🛠️ code │ 🔎 research │ ✍️ writer
   │
   ▼
Reply in your Slack thread + @mention
```

## Setup (about 15 min)

1. **Install**
   ```bash
   npm install
   cp .env.example .env
   ```

2. **Slack app**
   - Go to api.slack.com/apps → *Create New App* → *From a manifest*, then paste `slack-manifest.yml`.
   - *Basic Information* → *App-Level Tokens*: create a token with `connections:write`. That's your `SLACK_APP_TOKEN`.
   - *Install App* → copy the Bot token into `SLACK_BOT_TOKEN`.
   - Copy the signing secret into `SLACK_SIGNING_SECRET`.
   - In Slack, open your profile → ⋮ → *Copy member ID*, and put it in `OWNER_SLACK_ID`.

3. **Anthropic key**: put it in `ANTHROPIC_API_KEY` (console.anthropic.com).

4. **Give the code agent repos**
   ```bash
   mkdir workspace && cd workspace && git clone <your-repo>
   ```

5. **Run**
   ```bash
   npm start
   ```
   No Redis needed: jobs run in the same process. For production, set `REDIS_URL`
   and run `npm run worker` alongside the bot so jobs survive restarts.

## Using it

Your team: 🛠️ *Kai* (engineer), 🔎 *Nova* (researcher), ✍️ *Remy* (writer).

DM the bot or `@agents` it in a channel, and talk like you would to coworkers:

- `Kai, add input validation to the signup form in kassenwerk`
- `hey Nova, what are the newest prompt-injection defenses?`
- `Remy can you draft a message to my landlord about the heating`
- No name? The manager picks who fits.
- **Reply in the thread** to keep chatting with the same teammate. They remember the whole thread, even after a restart.
- **Name someone else mid-thread** ("Nova, double-check that") to hand the conversation over.
- In channels, once a teammate is in a thread, you can reply without @mentioning.
- **Attach files** (PDF, Word, Excel, images, text or code) to any message. Teammates read them, and they're saved under `workspace/uploads/` so Kai can work with them too. Needs the `files:read` scope.
- `help` lists the team.

### Team channels

`src/channels.js` gives channels a default teammate and background context, currently `#standup` (everyone), `#aloud` → Kai + Remy, `#thesis` and `#job-hunt` → Nova + Remy. In those channels you don't need to @mention anyone; just post. Run `/invite @agents` in each one. Private channels need the `groups:read` and `groups:history` scopes plus the `message.groups` event (all in the manifest). Channels not in the list only respond to @mentions.

Each teammate posts under their own name and avatar (needs the `chat:write.customize` scope, which is in the manifest).

## Add an agent

Add one entry to `src/agents.js` (name, icon, role, description, tools, prompt) and restart. That's it. The router learns about it from the description.

## Safety defaults

- Only `OWNER_SLACK_ID` can give orders.
- Agents run in `dontAsk` mode, so they can only use the tools listed for them. Everything else is refused.
- The code agent is told never to push or touch `.env`. Review its branches before merging.
- Every report shows the cost of the run.

## Hosting on AWS (EC2)

1. **Launch an instance** (EC2 console → Launch instance), region *Europe (Frankfurt)*:
   - Ubuntu Server 24.04 LTS, **t3.small** (2 GB RAM), 20 GB disk
   - Key pair: create `agent-team`, save the `.pem` to `~/.ssh/` and run `chmod 400 ~/.ssh/agent-team.pem`
   - Security group: **SSH from My IP only**. No other inbound ports (Socket Mode connects outbound).
2. **Configure deploy**: `cp deploy/.deploy.env.example deploy/.deploy.env` and fill in the instance's public IP.
3. **Stop the bot on your Mac** (Ctrl+C) so only one copy is connected to Slack.
4. **First deploy**: `./deploy/deploy.sh --first`
5. **Later updates**: `./deploy/deploy.sh`

Logs: `ssh -i ~/.ssh/agent-team.pem ubuntu@<ip> 'journalctl -u <APP_NAME> -f'` (APP_NAME from `deploy/.deploy.env`, default `agent-team`)
Repos for Kai: SSH in and `git clone` them into `~/agent-team/workspace/`.

## Logs

Every message and job gets one line, e.g.:

```
2026-10-11T14:02:11Z INFO  message channel=thesis agent=Nova routedBy=channel newThread=true text="what are good topics…"
2026-10-11T14:02:29Z INFO  job done agent=Nova secs=17.9 cost=$0.041 turns=4 tools=WebSearchx3,WebFetchx1
```

From your Mac:

- `./deploy/logs.sh` follows live logs
- `./deploy/logs.sh errors` shows warnings and errors from the last 24h
- `./deploy/logs.sh today` shows everything since midnight

Settings in `.env`: `LOG_LEVEL=debug` also logs each tool call, `LOG_FORMAT=json` gives machine-readable lines, and `LOG_CHANNEL=agent-logs` posts a 🚨 to that Slack channel on every error (create it and `/invite @agents`; name or ID both work). The server keeps 30 days or 200 MB of logs, whichever is smaller.

## Next steps

- Deploy: one small EC2/ECS instance plus ElastiCache Redis, or a single VPS with `docker compose`.
- More agents: plug in MCP servers (GitHub, Gmail, Google Calendar) through the Agent SDK's `mcpServers` option.
- Thread memory: pass earlier thread messages into the task so follow-ups have context.
