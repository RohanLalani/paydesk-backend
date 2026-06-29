import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter?: Transporter;
  private smtpConfig?: SmtpConfig;

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
    });
  }

  private async sendMail(message: {
    to: string;
    subject: string;
    html: string;
  }) {
    const transporter = this.getTransporter();
    const config = this.getSmtpConfig();

    await this.verifyTransporter(transporter, config);

    try {
      await transporter.sendMail({
        from: config.from,
        ...message,
      });
    } catch (error) {
      this.logSmtpError('SMTP send failed', error, config);
      throw error;
    }
  }

  private getTransporter() {
    if (!this.transporter) {
      const config = this.getSmtpConfig();

      const transportOptions: SMTPTransport.Options = {
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.user,
          pass: config.pass,
        },
        connectionTimeout: config.connectionTimeout,
        greetingTimeout: config.greetingTimeout,
        socketTimeout: config.socketTimeout,
        dnsTimeout: config.dnsTimeout,
      };

      this.transporter = createTransport(transportOptions);
    }

    return this.transporter;
  }

  private getSmtpConfig() {
    if (this.smtpConfig) {
      return this.smtpConfig;
    }

    const host = this.optionalEnv('SMTP_HOST');
    const portValue = this.optionalEnv('SMTP_PORT');
    const user = this.optionalEnv('SMTP_USER');
    const pass = this.optionalEnv('SMTP_PASS');
    const fromValue = this.optionalEnv('SMTP_FROM');
    const from = fromValue ?? user;
    const smtpSecureValue = this.optionalEnv('SMTP_SECURE');
    const port = this.parsePort(portValue);
    const configuredSecure = this.parseOptionalBoolean(smtpSecureValue);
    const secure = port === 465;

    this.logSmtpEnvironment({
      host,
      port,
      user,
      pass,
      from,
      fromValue,
      portValue,
      smtpSecureValue,
      configuredSecure,
      secure,
    });

    if (!host || !user || !pass || !from) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    if (configuredSecure !== undefined && configuredSecure !== secure) {
      this.logger.warn(
        `SMTP_SECURE=${configuredSecure} conflicts with SMTP_PORT=${port}; using secure=${secure} because Nodemailer should use secure=true only for port 465`,
      );
    }

    this.smtpConfig = {
      host,
      port,
      user,
      pass,
      from,
      secure,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      dnsTimeout: 10_000,
    };

    return this.smtpConfig;
  }

  private async verifyTransporter(
    transporter: Transporter,
    config: SmtpConfig,
  ) {
    try {
      await transporter.verify();
      this.logger.log(
        `SMTP transporter verified for host=${config.host} port=${config.port} secure=${config.secure} from=${config.from}`,
      );
    } catch (error) {
      this.logSmtpError('SMTP transporter verification failed', error, config);
      throw error;
    }
  }

  private logSmtpEnvironment(params: {
    host?: string;
    port: number;
    user?: string;
    pass?: string;
    from?: string;
    fromValue?: string;
    portValue?: string;
    smtpSecureValue?: string;
    configuredSecure?: boolean;
    secure: boolean;
  }) {
    this.logger.log(
      [
        'SMTP environment:',
        `SMTP_HOST=${this.exists(params.host)}`,
        `SMTP_PORT=${this.exists(params.portValue)}`,
        `SMTP_USER=${this.exists(params.user)}`,
        `SMTP_PASS=${this.exists(params.pass)}`,
        `SMTP_FROM=${this.exists(params.fromValue)}`,
        `SMTP_SECURE=${this.exists(params.smtpSecureValue)}`,
      ].join(' '),
    );
    this.logger.log(
      [
        'Resolved SMTP config:',
        `host=${params.host ?? '(missing)'}`,
        `port=${params.port}`,
        `secure=${params.secure}`,
        `smtpSecureEnv=${params.configuredSecure ?? '(unset)'}`,
        `from=${params.from ?? '(missing)'}`,
        'authUserPresent=' + this.exists(params.user),
        'authPassPresent=' + this.exists(params.pass),
        'pool=false',
        'connectionTimeout=15000',
        'greetingTimeout=15000',
        'socketTimeout=30000',
        'dnsTimeout=10000',
      ].join(' '),
    );
  }

  private logSmtpError(message: string, error: unknown, config: SmtpConfig) {
    const smtpError = error as SmtpError;
    const classification = this.classifySmtpError(error);

    this.logger.error(
      [
        message,
        `classification=${classification}`,
        `host=${config.host}`,
        `port=${config.port}`,
        `secure=${config.secure}`,
        `from=${config.from}`,
        `code=${smtpError?.code ?? '(none)'}`,
        `command=${smtpError?.command ?? '(none)'}`,
        `responseCode=${smtpError?.responseCode ?? '(none)'}`,
        `syscall=${smtpError?.syscall ?? '(none)'}`,
      ].join(' '),
      error instanceof Error ? error.stack : undefined,
    );
  }

  private classifySmtpError(error: unknown): SmtpErrorClassification {
    if (error instanceof ServiceUnavailableException) {
      return 'invalid configuration';
    }

    const smtpError = error as SmtpError;
    const code = smtpError?.code;
    const responseCode = smtpError?.responseCode;
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EDNS') {
      return 'DNS failure';
    }

    if (code === 'ETIMEDOUT' || message.includes('timeout')) {
      return 'connection timeout';
    }

    if (responseCode === 535 || responseCode === 534 || responseCode === 530) {
      return 'authentication failure';
    }

    if (
      code === 'ETLS' ||
      code === 'ESOCKET' ||
      message.includes('certificate') ||
      message.includes('tls') ||
      message.includes('ssl')
    ) {
      return 'TLS failure';
    }

    if (
      error instanceof Error &&
      (error.name.includes('Config') || message.includes('configured'))
    ) {
      return 'invalid configuration';
    }

    return 'unknown SMTP failure';
  }

  private optionalEnv(key: string) {
    const value = this.configService.get<string>(key);
    return value?.trim() || undefined;
  }

  private parsePort(value?: string) {
    const port = Number(value ?? 587);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    return port;
  }

  private parseOptionalBoolean(value?: string) {
    if (value === undefined) {
      return undefined;
    }

    if (/^(true|1|yes)$/i.test(value)) {
      return true;
    }

    if (/^(false|0|no)$/i.test(value)) {
      return false;
    }

    throw new ServiceUnavailableException('Email service is not configured');
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

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  dnsTimeout: number;
}

type SmtpError = {
  code?: string;
  command?: string;
  responseCode?: number;
  syscall?: string;
};

type SmtpErrorClassification =
  | 'DNS failure'
  | 'connection timeout'
  | 'authentication failure'
  | 'TLS failure'
  | 'invalid configuration'
  | 'unknown SMTP failure';
