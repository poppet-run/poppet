/** The whole answer a scheduled run gives when it has nothing to report. */
export const noReply = "NO_REPLY";

/** True only when the entire answer is the sentinel; an answer that merely mentions it is ordinary. */
export const isNoReply = (text: string) => text.trim() === noReply;
