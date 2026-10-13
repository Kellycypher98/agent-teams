# Case study: building an AI team I actually talk to

## The problem

I juggle an MSc in cybersecurity, a thesis, a language-learning app (Aloud), client work and a job hunt. Chat assistants help, but each conversation starts from zero, lives in a separate tab, and can't act: it can't touch my repo, send an email or remind me tomorrow.

I wanted something closer to a small team: people with clear roles I can message from my phone, who remember the context, pass work to each other, and check with me before doing anything that can't be undone.

## The approach

**Agents as teammates, not one assistant.** Four agents with narrow roles (engineer, researcher, writer, assistant), each with its own tools, model and budget. Narrow roles keep prompts short, make routing easy to explain, and let cheap models handle cheap work.

**Chat apps as the interface.** Slack first, Telegram later. Both already handle notifications, threads, files and buttons on every device, so there's no frontend to build.

**A platform-agnostic core.** Routing, teamwork, routines and approvals depend on a small adapter interface (`post`, `edit`, `askApproval`, `sendFile`, `dmWhere`, `handoffDest`). The Slack and Telegram adapters translate it. Adding Telegram after Slack touched almost nothing in the core.

**The Claude Agent SDK for the agent loop.** Each job is one `query()` call with an explicit tool list in `dontAsk` mode, resumed from the conversation's saved session. Team features (hand-offs, routines, files, email) are in-process MCP servers built with `createSdkMcpServer`, so they live in the same Node process and share its state.

**Humans approve side effects.** Any tool that sends, books or schedules writes a pending approval and returns. The real action runs only when I tap ✅, exactly once, with exactly the parameters I saw.

## Challenges and how I solved them

**"Only one of them answers."** Early on, naming two teammates in one message got one reply, and the standup channel only ever heard from one agent. The router was built to pick *a* teammate. I changed the model: messages fan out to every addressed teammate (leading names or @mentions), each gets its own session within the conversation, and follow-ups go to the same group. The standup channel uses an "all" mode where everyone replies briefly on Haiku and stays quiet if they have nothing to add.

**Agents that ignore each other.** Each SDK session only contains that agent's own turns, so the second teammate repeated the first. I added a short shared log per conversation (the last 12 turns, who said what) that goes into the system prompt only when another teammate has spoken. That keeps solo chats cheap.

**Hand-offs without infinite loops.** `ask_teammate` doesn't call the other agent directly; it queues a normal job, so hand-offs get the same budget checks, locks and logging as messages. A hop counter stops after three. On Telegram, a hand-off from a DM goes to the receiving bot's own DM, so I can keep talking to Iris where her message arrived.

**Time zones are hard.** Calendar files were off by an hour for recurring events that crossed the end of daylight saving time. One-off events now use UTC computed from the Europe/Berlin offset at that moment; recurring events keep `TZID` local time so the calendar app handles DST. Tests pin both cases, including the hour that happens twice.

**Costs creep.** Resumed sessions report cumulative cost, so my spend tracking was double-counting. I store the last total per session and record only the difference. On top of that: Haiku for routing, writing and standup replies, a cap per task, a daily budget that pauses the team, and the cost shown on every reply.

**Formatting across platforms.** Agents write Slack-style markdown; Telegram wants HTML and a 4096-character limit. The converter only treats `*` and `_` as formatting when they hug a word, so `2 * 3 * 4` and `snake_case` survive, and long replies split on line breaks.

**Small-server deployment.** `npm ci` was killed for running out of memory on a t3.micro, and the deploy script broke on macOS's bash 3.2 because of a Unicode ellipsis next to a variable name. The bootstrap script now adds swap automatically, and the deploy scripts are ASCII-only.

**Untrusted email.** Giving an agent an inbox invites prompt injection. Iris is told never to follow instructions in emails, sending always needs my approval, and attachments can only come from the workspace (a path-traversal test covers `../.env`). Inbox reading is switched off until I've tested those defenses against real mail.

## Results

- About 2,500 lines of JavaScript; four agents on two chat apps; Gmail, Google Calendar and Outlook integration.
- Runs 24/7 on one small EC2 instance behind systemd, with structured logs and error alerts sent to a chat channel.
- A daily morning routine that drafts, hands off and delivers a post for me to proofread.
- 28 automated tests in CI, including end-to-end runs of four Telegram bots against a fake Bot API with the Agent SDK mocked.
- Daily cost stays inside a budget I set, with the cost of every task visible.

## What I'd do next

- An evaluation set for routing and hand-off decisions, so prompt changes can be measured rather than eyeballed.
- Webhooks and Redis by default, so it can run as more than one instance.
- Inbox reading for Iris, behind injection tests built from real-world attack emails.
