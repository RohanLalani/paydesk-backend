import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter?: Transporter;

  async sendPasswordResetEmail(params: {
    to: string;
    name?: string | null;
    resetUrl: string;
    type: string;
  }) {
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;

    if (!from) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    await this.getTransporter().sendMail({
      from,
      to: params.to,
      subject: 'Reset your Pay Desk password',
      html: this.renderPasswordResetTemplate(params),
    });
  }

  async sendEmailVerificationEmail(params: {
    to: string;
    name?: string | null;
    verificationUrl: string;
    type: string;
  }) {
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;

    if (!from) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    await this.getTransporter().sendMail({
      from,
      to: params.to,
      subject: 'Verify your Pay Desk email',
      html: this.renderEmailVerificationTemplate(params),
    });
  }

  private getTransporter() {
    if (!this.transporter) {
      const port = Number(process.env.SMTP_PORT ?? 587);

      this.transporter = createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth:
          process.env.SMTP_USER && process.env.SMTP_PASS
            ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
              }
            : undefined,
      });
    }

    return this.transporter;
  }

  private renderPasswordResetTemplate(params: {
    name?: string | null;
    resetUrl: string;
    type: string;
  }) {
    const greeting = params.name
      ? `Hi ${this.escapeHtml(params.name)},`
      : 'Hi,';
    const accountType = this.escapeHtml(params.type);
    const resetUrl = this.escapeHtml(params.resetUrl);

    return `
      <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
        <h2 style="margin: 0 0 16px;">Reset your Pay Desk password</h2>
        <p>${greeting}</p>
        <p>We received a request to reset the password for your ${accountType} account.</p>
        <p>
          <a href="${resetUrl}" style="display: inline-block; padding: 12px 18px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px;">
            Reset password
          </a>
        </p>
        <p>This link expires in 15 minutes and can only be used once.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `;
  }

  private renderEmailVerificationTemplate(params: {
    name?: string | null;
    verificationUrl: string;
    type: string;
  }) {
    const greeting = params.name
      ? `Hi ${this.escapeHtml(params.name)},`
      : 'Hi,';
    const accountType = this.escapeHtml(params.type);
    const verificationUrl = this.escapeHtml(params.verificationUrl);

    return `
      <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
        <h2 style="margin: 0 0 16px;">Verify your Pay Desk email</h2>
        <p>${greeting}</p>
        <p>Please verify the email address for your ${accountType} account.</p>
        <p>
          <a href="${verificationUrl}" style="display: inline-block; padding: 12px 18px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px;">
            Verify email
          </a>
        </p>
        <p>This link expires in 24 hours and can only be used once.</p>
        <p>If you did not create this account, you can ignore this email.</p>
      </div>
    `;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
