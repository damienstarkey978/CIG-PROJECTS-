import nodemailer from "nodemailer";
import type { EmailProvider, OutgoingEmail } from "./types";

export interface SmtpSecrets {
  host: string;
  port: number | string;
  user: string;
  pass: string;
  fromEmail: string;
  fromName?: string;
}

type Transport = { sendMail(opts: any): Promise<{ messageId?: string }> };

/** Plain SMTP, which covers Google Workspace (app password), Microsoft 365, and most business email. */
export class SmtpEmail implements EmailProvider {
  readonly name = "smtp";
  private readonly transport: Transport;

  constructor(private readonly s: SmtpSecrets, makeTransport: (o: any) => Transport = nodemailer.createTransport) {
    const port = Number(s.port);
    this.transport = makeTransport({ host: s.host, port, secure: port === 465, auth: { user: s.user, pass: s.pass } });
  }

  async send(msg: OutgoingEmail): Promise<{ id: string | null }> {
    const info = await this.transport.sendMail({
      from: this.s.fromName ? { name: this.s.fromName, address: this.s.fromEmail } : this.s.fromEmail,
      to: msg.to,
      cc: msg.cc.length ? msg.cc : undefined,
      subject: msg.subject,
      text: msg.text,
    });
    return { id: info.messageId ?? null };
  }
}
