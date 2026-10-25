/** collection/mail.py MailMessage: one notification as the parsers read it. */
export type MailMessage = { messageId: string; sender: string; subject: string; body: string; isHtml: boolean; receivedAt: string };
