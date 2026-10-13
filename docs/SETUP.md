# Setup & operations

Everything needed to run your own copy. For what the project is and how it works, see the [README](../README.md).

## 1. Install

```bash
git clone <this repo> agent-team && cd agent-team
npm install
cp .env.example .env
```

Put your Anthropic key in `ANTHROPIC_API_KEY` (console.anthropic.com), and your name and a one-line bio in `OWNER_NAME` / `OWNER_BIO` so the team knows who they work for. Run `npm start`; with no chat app configured it exits and tells you what's missing. Set up Slack, Telegram or both below.

No Redis needed: jobs run in the same process. For production you can set `REDIS_URL` and run `npm run worker` alongside the bot so queued jobs survive restarts.

## 2. Slack

1. Go to api.slack.com/apps → *Create New App* → *From a manifest*, then paste `slack-manifest.yml`.
2. *Basic Information* → *App-Level Tokens*: create a token with `connections:write`. That's your `SLACK_APP_TOKEN`.
3. *Install App* → copy the Bot token into `SLACK_BOT_TOKEN`, and the signing secret into `SLACK_SIGNING_SECRET`.
4. In Slack, open your profile → ⋮ → *Copy member ID*, and put it in `OWNER_SLACK_ID`.

## 3. Telegram

The same team, memory and budget, on Telegram. Each teammate is their own bot.

1. In Telegram, open **@BotFather** and send `/newbot` four times: Kai, Nova, Remy, Iris (usernames must end in `bot`, e.g. `yourname_kai_bot`). Copy each token into `TELEGRAM_TOKEN_KAI`, `_NOVA`, `_REMY`, `_IRIS`.
2. For the lead bot (Remy by default): in @BotFather send `/setprivacy`, pick the bot, choose **Disable**, so it can read the group.
3. Message **@userinfobot** to get your numeric id, put it in `TELEGRAM_OWNER_ID`.
4. Create a group, turn on **Topics** (group settings), add all four bots. Create topics `standup`, `aloud`, `thesis`, `job-hunt`, `admin`, and inside each one type `/channel <name>` (e.g. `/channel thesis`).
5. Send `/start` to each bot in a DM once (so they can message you, e.g. Iris's approvals and error alerts).

Using it: post in a topic, `@kai_bot …` or reply to a teammate's message to talk to them, DM a bot to talk to just that teammate. `/new` starts a fresh conversation in that topic or DM (cheaper than one endless one), `/spend` shows costs, `/help` lists the team.

## 4. Email & calendar (Iris, optional)

Iris drafts and sends email from your Gmail and Outlook, checks both calendars and finds free time. **Reading your inbox is switched off for now** (commented out in `src/integrations/index.js`; see the note at `MAIL_TOOLS` to turn it back on). **Sending an email or adding an event always shows ✅ / ❌ buttons first**; nothing goes out until you tap ✅, and it goes out exactly as previewed.

**Google (Gmail + Google Calendar)**, about 10 min, once:
1. console.cloud.google.com → new project → *APIs & Services* → enable **Gmail API** and **Google Calendar API**.
2. *OAuth consent screen*: External, add yourself as a test user, then **Publish app** ("In production"), otherwise the login expires every 7 days. You'll see an "unverified app" warning when signing in; that's expected for a personal app (Advanced → continue).
3. *Credentials* → *Create credentials* → *OAuth client ID* → **Desktop app**. Put the ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. On your Mac: `npm run auth:google` (opens the browser, saves `GOOGLE_REFRESH_TOKEN` to `.env`).

**Microsoft (personal Outlook mail + calendar)**, about 5 min, once:
1. entra.microsoft.com (or portal.azure.com) → *App registrations* → *New registration*, account type **Personal Microsoft accounts only**. No redirect URI needed.
2. *Authentication* → **Allow public client flows: Yes** → Save. Copy the *Application (client) ID* into `MS_CLIENT_ID`.
3. On your Mac: `npm run auth:microsoft`, open the link, enter the code (saves `MS_REFRESH_TOKEN` to `.env`).

Then `./deploy/deploy.sh`. Ask `help` to check both accounts show ✅.

**Slack:** approvals use buttons, so turn on *Interactivity & Shortcuts* in your Slack app settings (already in the manifest).

**Security:** emails are untrusted input. Iris is told never to follow instructions inside an email, and even if she were tricked, she can't send anything without your ✅. She can only attach files you've shared with the team (nothing outside `workspace/`). Tokens live in `.env` / `data/` on the server, readable only by the bot user.

**Job applications:** Nova finds roles, Remy tailors the CV and cover letter, Iris sends email applications with your CV attached after you approve. Portal applications (LinkedIn, StepStone, Workday…) are prepared for you to paste and submit yourself; automating those breaks their terms and risks your account.

## 5. Hosting on AWS (EC2)

1. **Launch an instance** (EC2 console → Launch instance), region *Europe (Frankfurt)*:
   - Ubuntu Server 24.04 LTS, **t3.small** (2 GB RAM), 20 GB disk
   - Key pair: create `agent-team`, save the `.pem` to `~/.ssh/` and run `chmod 400 ~/.ssh/agent-team.pem`
   - Security group: **SSH from My IP only**. No other inbound ports (Socket Mode connects outbound).
2. **Configure deploy**: `cp deploy/.deploy.env.example deploy/.deploy.env` and fill in the instance's public IP.
3. **Stop the bot on your Mac** (Ctrl+C) so only one copy is connected.
4. **First deploy**: `./deploy/deploy.sh --first`
5. **Later updates**: `./deploy/deploy.sh`

Logs: `ssh -i ~/.ssh/agent-team.pem ubuntu@<ip> 'journalctl -u <APP_NAME> -f'` (APP_NAME from `deploy/.deploy.env`, default `agent-team`)
### Repos for Kai

1. On GitHub create a fine-grained token: *Only select repositories* (pick the repos), *Repository permissions → Contents: Read and write*.
2. On the server:
   ```bash
   git config --global credential.helper store
   git config --global user.name "Kai (agent-team)"
   git config --global user.email "<you@example.com>"
   git config --global core.hooksPath ~/agent-team/deploy/git-hooks
   cd ~/agent-team/workspace && git clone https://github.com/<you>/<repo>.git
   ```
   Paste the token as the password; it's saved for later pushes.

Kai works on `kai/<topic>` branches, pushes them and sends you the pull-request link. The `pre-push` hook blocks pushes to any other branch and branch deletions, so you review and merge everything yourself.

# Using the team

## Using it on Slack

Your team: 🛠️ *Kai* (engineer), 🔎 *Nova* (researcher), ✍️ *Remy* (writer), 📅 *Iris* (assistant: email + calendars).

DM the bot or `@agents` it in a channel, and talk like you would to coworkers:

- `Kai, add input validation to the signup form in kassenwerk`
- `hey Nova, what are the newest prompt-injection defenses?`
- `Remy can you draft a message to my landlord about the heating`
- No name? The manager picks who fits.
- **Reply in the thread** to keep chatting with the same teammate. They remember the whole thread, even after a restart.
- **Name someone else mid-thread** ("Nova, double-check that") to hand the conversation over.
- In channels, once a teammate is in a thread, you can reply without @mentioning.
- **Attach files** (PDF, Word, Excel, images, text or code) to any message. Teammates read them, and they're saved under `workspace/uploads/` so Kai can work with them too. Needs the `files:read` scope.
- **Files back:** teammates can post `.ics` calendar files (tap to add to Apple/Google/Outlook) and other text files (CSV, Markdown, code) in the thread, e.g. `Remy, make calendar events for my exam dates`. Needs the `files:write` scope.
- `help` lists the team.

### Team channels

`src/channels.js` gives channels a default teammate and background context, currently `#standup` (everyone replies briefly, on Haiku), `#aloud` → Kai + Remy, `#thesis` → Nova + Remy, `#job-hunt` → Nova + Remy + Iris, `#admin` → Iris. In those channels you don't need to @mention anyone; just post. Run `/invite @agents` in each one. Private channels need the `groups:read` and `groups:history` scopes plus the `message.groups` event (all in the manifest). Channels not in the list only respond to @mentions.

Each teammate posts under their own name and avatar (needs the `chat:write.customize` scope, which is in the manifest).

## Working as a team

- **Several people at once:** start with their names, e.g. `Kai and Nova, should I add 2FA to Aloud?` or `@kai_bot @nova_bot …`. Each replies, and follow-ups in that conversation go to the same group.
- **They see each other:** in a shared conversation every teammate gets the recent messages from you and the others, so they build on each other instead of repeating.
- **Hand-offs:** teammates pass work along with `ask_teammate` (Remy writes → asks Iris to email it; Nova researches → asks Remy to turn it into a post). The receiver answers in the same conversation (on Telegram DMs: in their own DM with you). Max 3 hand-offs in a row.

## Routines

Recurring jobs that run on their own. Built in:

- **Morning X post** (`x-post`, 08:00 daily): Remy drafts a post (≤280 chars, rotating themes, remembers his last 10 so he doesn't repeat), hands it to Iris, and Iris DMs it to you to proofread. Reply in that DM with edits ("punchier", "mention Aloud") and Iris fixes it or asks Remy.

Create more by asking: _"Nova, every Friday at 17:00 send me 3 security news items"_ → you get ✅/❌ buttons to approve. Commands (any chat): `routines`, `run x-post`, `pause x-post`, `resume x-post`, `time x-post 07:30`, `delete <id>`. Routines run in Europe/Berlin time and count towards the daily budget. Edit the built-in X post instructions in `src/routines.js`.

# Running it

## Keeping costs down

- **Models per teammate:** Kai, Nova and Iris run on Sonnet, Remy on Haiku. Override with `MODEL_CODE`, `MODEL_RESEARCH`, `MODEL_WRITER`, `MODEL_ASSISTANT`.
- **Per-task cap:** a task stops at `MAX_USD_*` (defaults $0.75 Kai, $0.30 Nova, $0.05 Remy, $0.25 Iris) and asks before continuing.
- **Daily budget:** `DAILY_BUDGET_USD` (default $3). When reached, the team pauses until midnight.
- **#standup**: everyone replies, but on Haiku and in 2-4 lines; anyone with nothing to add stays quiet. Naming someone uses their full model.
- Send `spend` to see today's, this week's and this month's costs.
- Long threads get more expensive with every reply (the whole thread is re-read), so start a new thread for a new topic.
- Also set a monthly spend limit in the Anthropic console as a final backstop.

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

## Safety defaults

- Only `OWNER_SLACK_ID` / `TELEGRAM_OWNER_ID` can give orders; everyone else is ignored.
- Agents run in `dontAsk` mode, so they can only use the tools listed for them. Everything else is refused.
- Kai can only push `kai/*` branches (enforced by a git hook on the server) and never touches `.env`. Review his pull requests before merging.
- Every report shows the cost of the run.

## Add an agent

Add one entry to `src/agents.js` (name, icon, role, description, tools, model, prompt) and restart (for Telegram also add a `TELEGRAM_TOKEN_<NAME>` bot). That's it. The router learns about it from the description.
