export { SOURCES, sourceSettings } from "./catalog";
export { SourceError, type Collected, type Connector, type MailSourceSettings, type PageSourceSettings, type SourceErrorKind, type SourceSettings } from "./types";
export { readMessage, type MailMessage } from "./mail/message";
export { MailRejection, type MailReason } from "./mail/reasons";
export { inboxAddress, ReceivingClient } from "./mail/receiving";
export { loadCursor, recordedMessages, recordMessage, saveCursor, type MailCursor, type MailOutcome } from "./mail/store";
