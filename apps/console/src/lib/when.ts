/** A moment as the lists tell it: its day, and its time to the minute. */
export const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A moment as what tells all of one thing tells it: to the second. */
export const whenExact = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
