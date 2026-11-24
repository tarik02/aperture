/** Whether a password was just set with a setup link that did not sign its holder in. */
let set = false;

export const notePasswordSet = () => {
  set = true;
};

/** Whether one was, told once: the page that signs in says so, the first time it is shown after. */
export const takePasswordSet = () => {
  const was = set;
  set = false;
  return was;
};
