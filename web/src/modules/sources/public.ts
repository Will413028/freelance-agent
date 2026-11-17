export { SOURCES, sourceLabel, sourceSettings } from "./catalog";
export { SourceError, type Collected, type Connector, type MailSourceSettings, type PageSourceSettings, type SourceErrorKind, type SourceSettings } from "./types";
export { readMessage, type MailMessage } from "./mail/message";
export { FINAL_REASONS, isReasonOf, MailRejection, type MailReason } from "./mail/reasons";
export { inboxAddress, ReceivingClient } from "./mail/receiving";
export {
  loadCursor, markRejected, pruneMailMessages, recordedMessages, recordMessage, rejectedGroups, retryMessages, saveCursor,
  type MailCursor, type MailDisposition, type MailOutcome, type RejectedGroup,
} from "./mail/store";
