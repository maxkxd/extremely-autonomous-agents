// Help topics: the tutorial behind each page's "?" button.
//
// One topic per page, one tab each in the help window. Every section is a big
// diagram (diagrams.tsx) with a sentence or two under it.
//
// Captions can link to another tab's help: [words](tab), e.g. [Approvals](approvals),
// or to a page of the app: [words](page:view), e.g. [New Agent](page:new-agent).
// A caption is a sentence or two, or a list of blocks: a string is a line, an
// array of strings is a bullet list.
//
// To add help to a new page: add a topic here (and its diagrams), and map its
// view in helpTopicFor(). To change a topic so everyone sees it again: bump
// its `version` - its "?" glows until the new version is read.

import type { View } from '../Sidebar';
import type { DiagramId } from './diagrams';

// No caption: the picture says it. No diagram: the words do.
export type HelpCaption = string | (string | string[])[];
export type HelpSection = { heading: string; caption?: HelpCaption; diagram?: DiagramId };
export type HelpTopic = { title: string; version: number; sections: HelpSection[] };

export const HELP_TOPICS = {
  // Not a page's help: the first thing anyone sees in the help window. Until
  // it's read, every "?" glows and opens on it (HelpButton.tsx).
  start: {
    title: 'Getting started',
    version: 3,
    sections: [
      {
        heading: 'Welcome to Extremely Autonomous Agents',
        diagram: 'think-bigger',
        caption: [
          "When you build an agent here, DON'T PLAN:",
          [
            'A marketing agent that delivers a daily strategic marketing report.',
            'A sales agent that sorts sales inquiries in your inbox.',
          ],
          'PLAN:',
          [
            'A sales agent that aggressively searches, finds and works so many leads that its blocker is storage space in your email inbox.',
            'A marketing agent that dives deep into the numbers and, overnight, makes active campaigns driven by high quality copy and content faster than you could hope to review them.',
          ],
        ],
      },
      {
        heading: 'Make your first agent',
        diagram: 'first-agent',
        caption: [
          "Now that you have the idea of what we mean by extremely autonomous agents, make your first one in [New Agent](page:new-agent):",
          [
            'Choose an existing agent pack, or try the custom agent builder.',
            'Give it real, scalable work it can do.',
            'Tell it what you want human intervention for, and what you want fully autonomous.',
          ],
        ],
      },
      {
        heading: 'Its first run',
        diagram: 'first-run',
        caption: [
          "Once you've added your first agent, give it a little while to finish setting up. Then explore the [Dashboard](dashboard) while the agent does its first run.",
          'Meanwhile, in the background:',
          [
            'The Agency Engineer is hard at work building the tools your agents need.',
            '[Requests](requests) will start to pop up for you to answer. Each one gives your agents a tool to work with and makes them more capable forever.',
          ],
          "We're super excited to hear what kind of insane agents you can build to push agentic AI to its limits!",
        ],
      },
    ],
  },
  dashboard: {
    title: 'Dashboard',
    version: 4,
    sections: [
      {
        heading: 'Agent card',
        diagram: 'agent-card',
        caption: 'Every agent has a card. This is where you and your team will control and manage all your agents.',
      },
      {
        heading: 'Output and cost',
        diagram: 'output-cost',
        caption: 'Output is the value the agent is giving you, and cost is what it spent doing it. Hover over a slice to see more detail.',
      },
      {
        heading: 'Ferocity',
        diagram: 'ferocity',
        caption: 'How hard an agent maximizes its output, use this to balance output, cost and frequency of [resource requests](requests).',
      },
      {
        heading: 'The right-hand column',
        diagram: 'card-side',
      },
      {
        heading: 'Choosing models',
        diagram: 'models',
        caption: 'Pick up to three AI models, in order. Number 1 is the default; if it fails, 2 takes over, then 3.',
      },
    ],
  },
  approvals: {
    title: 'Approvals',
    version: 4,
    sections: [
      {
        heading: 'Silent, Logged or Approval',
        diagram: 'tiers',
        caption:
          "Every tool an agent can use is set to Silent, Logged or Approval. Silent tools just run. Logged tools run and show up in the agent's [DMs](dm). Approval tools require a human's approval.",
      },
      {
        heading: 'Approval card',
        diagram: 'approval-card',
        caption: "This is an approval card, the human gate on each agent's work.",
        // LATER: approval cards will get a button to move a tool from Approval
        // down to Logged or Silent. Explain it here (and show it in the picture) once it exists.
      },
      {
        heading: 'Approve or reject',
        diagram: 'approve-reject',
        caption: 'Approve and the agent goes ahead or Reject with a reason and the agent sees it. Shift-click Reject to skip adding a reason.',
      },
    ],
  },
  requests: {
    title: 'Requests',
    version: 3,
    sections: [
      {
        heading: 'Request',
        diagram: 'request',
        caption:
          "When an agent can't do its job without something - an account, access or a tool - it files a request instead of giving up. The Agency Engineer answers with how to fix it, and what it needs from you.",
      },
      {
        heading: 'Answering a request',
        diagram: 'request-answer',
      },
    ],
  },
  dm: {
    title: 'Agent DMs',
    version: 3,
    sections: [
      {
        heading: 'A post for every run',
        diagram: 'run-post',
        caption:
          'Every run ends with a post: what it did, what it cost, how long it took and the tools it used. A yellow dot means a tool is waiting on your [approval](approvals).',
      },
      {
        heading: 'Talk to it',
        diagram: 'talk',
        caption: "Ask what it's up to, or hand it something specific. Day to day it works on its own - you shouldn't need to be here.",
      },
    ],
  },
} satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;
export const HELP_TOPIC_IDS = Object.keys(HELP_TOPICS) as HelpTopicId[];

// Which topic a page shows, or null for a page without help.
export function helpTopicFor(view: View): HelpTopicId | null {
  if (view.startsWith('agent:')) return 'dm';
  return view in HELP_TOPICS ? (view as HelpTopicId) : null;
}
