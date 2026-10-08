/** Quotes one shell word only when it needs it, so a command line stays readable. */
export const shq = (word: string) => (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
