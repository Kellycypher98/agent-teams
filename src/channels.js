// Channel setup. Keyed by Slack channel name (without #) or channel ID (e.g. C0123ABCD).
// IDs work even without the channels:read scope: right-click channel → Copy link → the C… at the end.
//
// team:    who works in this channel. The first one is the default;
//          with more than one, the manager picks between them.
// context: extra background every teammate gets in this channel.
// mode:    'all' = every teammate replies to each new post (unless you name one). Default: one teammate.
//
// In channels listed here, the team reads every message you post, no @mention needed.
// In channels not listed, they only respond when you @mention the bot.
// Remember to /invite @agents in each channel.

const jobHunt = {
  team: ['research', 'writer'],
  context: 'Job search: researching companies, tailoring CVs and cover letters. Kelvin is based in Berlin.',
};

export const channels = {
  standup: {
    team: ['code', 'research', 'writer'],
    mode: 'all',
    context: 'Team standup. Kelvin posts updates, plans or questions and the whole team weighs in. ' +
      'Give your own take from your role in a few lines; skip anything outside your area rather than repeating teammates.',
  },
  aloud: {
    team: ['code', 'writer'],
    context: "Project: Aloud, Kelvin's language-learning app (React Native). The repo is in ./aloud.",
  },
  thesis: {
    team: ['research', 'writer'],
    context: "Kelvin's MSc Cybersecurity thesis. Academic tone, cite sources properly.",
  },
  'job-hunt': jobHunt,
  jobhunt: jobHunt, // either spelling works

  // Add more later, e.g.:
  // kassenwerk: { team: ['code'], context: 'Kassenwerk POS/inventory platform. Repo in ./kassenwerk.' },
};
