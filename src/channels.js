// Channel setup. Keyed by Slack channel name (without #) or channel ID (e.g. C0123ABCD).
// IDs work even without the channels:read scope: right-click channel → Copy link → the C… at the end.
//
// team:    who works in this channel. The first one is the default;
//          with more than one, the manager picks between them.
// context: extra background every teammate gets in this channel.
// mode:    'relevant' = only teammates with something to add reply (say "everyone" for all);
//          'all' = every teammate replies every time. Default: one teammate per thread.
// replyModel: cheaper model for group replies in 'all'/'relevant' channels (naming someone uses their own model).
//
// Telegram: create a group with Topics, add the bots, then type /channel <name> inside each topic.
//
// In channels listed here, the team reads every message you post, no @mention needed.
// In channels not listed, they only respond when you @mention the bot.
// Remember to /invite @agents in each channel.
import { OWNER } from './profile.js';

const HAIKU = process.env.ROUTER_MODEL || 'claude-haiku-5-5';

const jobHunt = {
  team: ['research', 'writer', 'assistant'],
  context: `Job search: researching companies, tailoring CVs and cover letters, sending email applications (Iris, after approval). ${OWNER} is based in Berlin.`,
};

export const channels = {
  standup: {
    team: ['code', 'research', 'writer'],
    mode: 'all',
    replyModel: HAIKU,
    context: `Team standup. ${OWNER} posts updates, plans or questions and the whole team weighs in. ` +
      'Give your own take from your role in a few lines; skip anything outside your area rather than repeating teammates.',
  },
  aloud: {
    team: ['code', 'writer'],
    context: `Project: Aloud, ${OWNER}'s language-learning app (React Native). The repo is in ./aloud.`,
  },
  thesis: {
    team: ['research', 'writer'],
    context: `${OWNER}'s MSc Cybersecurity thesis. Academic tone, cite sources properly.`,
  },
  admin: {
    team: ['assistant'],
    context: 'Email, calendar and life admin.',
  },
  'job-hunt': jobHunt,
  jobhunt: jobHunt, // either spelling works

  // Add more later, e.g.:
  // kassenwerk: { team: ['code'], context: 'Kassenwerk POS/inventory platform. Repo in ./kassenwerk.' },
};
