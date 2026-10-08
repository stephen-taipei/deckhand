/** `$.session.append`'s argument: a hidden user note the model reads on its next request. */
export const noteForModel = (text: string) => ({
  message: { type: 'user' as const, content: [{ type: 'text' as const, text: `[deckhand] ${text}` }] },
})

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
