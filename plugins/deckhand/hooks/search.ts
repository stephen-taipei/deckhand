/**
 * The `search` tool: hands web research to the delegate the person chose in settings (Codex, Cursor
 * agent or agy, read-only, through bin/delegate.py with `--web`), so the main model gets a sourced
 * summary to check instead of running every search itself.
 */

export type SearchInput = {
  question: string
  context?: string
  /** How recent the answer must be, in the asker's words (`2026`, `last 30 days`, `latest release`). */
  freshness?: string
}

export const buildSearchPrompt = (input: SearchInput, languageName: string) =>
  [
    'You are a research assistant. Answer the QUESTION below by searching the web.',
    '',
    'RULES:',
    '- Use only web search and reading web pages. Run no terminal command, and read or change no local file.',
    '- Prefer primary sources: official documentation, release notes, standards, the vendor\'s own pages. Use other sources only to fill gaps, and say so.',
    '- For anything that changes over time (versions, prices, availability, limits, dates), give each source\'s date and prefer the newest.',
    '- Never invent a URL or a quote. Cite only pages you actually opened or saw in the results.',
    '- When sources disagree, say which says what. Mark anything you could not confirm as "unverified".',
    '- Keep product names, code, commands, numbers and units as they are.',
    `- Write in ${languageName}.`,
    '',
    'ANSWER FORMAT:',
    '1. The answer, in one to three sentences.',
    '2. Key points, one line each, each ending with its source URL.',
    '3. Conflicts or open questions, if any.',
    '4. Sources: every URL used, with its date when the page shows one.',
    'No preamble and no closing remarks.',
    ...(input.freshness ? ['', `FRESHNESS: ${input.freshness}`] : []),
    ...(input.context ? ['', `CONTEXT (why it is asked): ${input.context}`] : []),
    '',
    'QUESTION:',
    '<<<',
    input.question,
    '>>>',
  ].join('\n')

export const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'What to find out, as a complete question that stands on its own.' },
    context: { type: 'string', description: 'Why it is asked and what the answer is for, so the search aims right.' },
    freshness: { type: 'string', description: 'How recent the answer must be, e.g. "2026", "last 30 days", "latest release".' },
  },
  required: ['question'],
} as const
