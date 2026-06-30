import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend?: Resend;
  private emailConfig?: EmailConfig;

  constructor(private readonly configService: ConfigService) {}

  async sendPasswordResetEmail(params: {
    to: string;
    name?: string | null;
    resetUrl: string;
    type: string;
  }) {
    await this.sendMail({
      to: params.to,
      subject: 'Reset your Pay Desk password',
      html: this.renderPasswordResetTemplate(params),
      text: this.renderPasswordResetText(params),
    });
  }

  async sendEmailVerificationEmail(params: {
    to: string;
    name?: string | null;
    verificationUrl: string;
    type: string;
  }) {
    await this.sendMail({
      to: params.to,
      subject: 'Verify your Pay Desk email',
      html: this.renderEmailVerificationTemplate(params),
      text: this.renderEmailVerificationText(params),
    });
  }

  private async sendMail(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }) {
    const resend = this.getResendClient();
    const config = this.getEmailConfig();

    try {
      this.logger.log(
        `Email send requested provider=resend from=${config.from} to=${message.to}`,
      );
      const result = await resend.emails.send({
        from: config.from,
        ...message,
      });

      if (result.error) {
        throw result.error;
      }

      this.logger.log(
        `Email send succeeded provider=resend from=${config.from} to=${message.to} id=${result.data?.id ?? '(none)'}`,
      );
    } catch (error) {
      this.logResendError('Resend email send failed', error, config, {
        to: message.to,
      });
      throw new ServiceUnavailableException('Email service failed to send');
    }
  }

  private getResendClient() {
    if (!this.resend) {
      const config = this.getEmailConfig();
      this.resend = new Resend(config.apiKey);
    }

    return this.resend;
  }

  private getEmailConfig() {
    if (this.emailConfig) {
      return this.emailConfig;
    }

    const apiKey = this.optionalEnv('RESEND_API_KEY');
    const emailFromValue = this.optionalEnv('EMAIL_FROM');
    const smtpFromValue = this.optionalEnv('SMTP_FROM');
    const from = emailFromValue ?? smtpFromValue;

    this.logger.log(
      [
        'Email environment:',
        'provider=resend',
        `RESEND_API_KEY=${this.exists(apiKey)}`,
        `EMAIL_FROM=${this.exists(emailFromValue)}`,
        `SMTP_FROM=${this.exists(smtpFromValue)}`,
      ].join(' '),
    );
    this.logger.log(
      [
        'Resolved email config:',
        'provider=resend',
        `from=${from ?? '(missing)'}`,
      ].join(' '),
    );

    if (!apiKey || !from) {
      this.logger.error(
        `Email service is not configured provider=resend RESEND_API_KEY=${this.exists(apiKey)} EMAIL_FROM=${this.exists(emailFromValue)} SMTP_FROM=${this.exists(smtpFromValue)}`,
      );
      throw new ServiceUnavailableException('Email service is not configured');
    }

    this.emailConfig = { apiKey, from };
    return this.emailConfig;
  }

  private logResendError(
    message: string,
    error: unknown,
    config: EmailConfig,
    context: { to: string },
  ) {
    const resendError = error as ResendError;

    this.logger.error(
      [
        message,
        'provider=resend',
        `from=${config.from}`,
        `to=${context.to}`,
        `name=${resendError?.name ?? '(none)'}`,
        `statusCode=${resendError?.statusCode ?? '(none)'}`,
        `message=${this.safeErrorMessage(error)}`,
      ].join(' '),
      error instanceof Error ? error.stack : undefined,
    );
  }

  private safeErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    const maybeMessage = (error as { message?: unknown })?.message;
    return typeof maybeMessage === 'string' ? maybeMessage : '(none)';
  }

  private optionalEnv(key: string) {
    const value = this.configService.get<string>(key);
    return value?.trim() || undefined;
  }

  private exists(value?: string) {
    return value ? 'present' : 'missing';
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

  private renderPasswordResetText(params: {
    name?: string | null;
    resetUrl: string;
    type: string;
  }) {
    const greeting = params.name ? `Hi ${params.name},` : 'Hi,';

    return [
      'Reset your Pay Desk password',
      '',
      greeting,
      `We received a request to reset the password for your ${params.type} account.`,
      `Reset password: ${params.resetUrl}`,
      'This link expires in 15 minutes and can only be used once.',
      'If you did not request this, you can ignore this email.',
    ].join('\n');
  }

  private renderEmailVerificationText(params: {
    name?: string | null;
    verificationUrl: string;
    type: string;
  }) {
    const greeting = params.name ? `Hi ${params.name},` : 'Hi,';

    return [
      'Verify your Pay Desk email',
      '',
      greeting,
      `Please verify the email address for your ${params.type} account.`,
      `Verify email: ${params.verificationUrl}`,
      'This link expires in 24 hours and can only be used once.',
      'If you did not create this account, you can ignore this email.',
    ].join('\n');
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

interface EmailConfig {
  apiKey: string;
  from: string;
}

type ResendError = {
  name?: string;
  message?: string;
  statusCode?: number;
};
