/**
 * What is said of a failure as one sentence, however whoever answered worded it: it starts
 * with a capital and ends with a full stop, as everything the console says of failures does.
 */
export const sentence = (said: string) => {
  const text = said.trim();
  if (text === "") {
    return text;
  }
  const started = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…]$/u.test(started) ? started : `${started}.`;
};
