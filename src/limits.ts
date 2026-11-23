/** Constants shared by the server and the browser. No server imports here. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_QUESTION_LENGTH = 2000;
export const NOT_COVERED = "The contract does not cover this.";
export const UNVERIFIED_ANSWER = "I couldn't verify an answer against the contract, so I'm not showing one.";
/** Stands in for a quote the model gave that is not in the contract. */
export const QUOTE_REMOVED = "[quote removed: not found in the contract]";
