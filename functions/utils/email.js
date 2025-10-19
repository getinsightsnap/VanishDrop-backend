import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create reusable transporter
const createTransporter = () => {
  // Check if using Gmail or custom SMTP
  if (process.env.EMAIL_SERVICE === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD, // Use App Password for Gmail
      },
    });
  }
  
  // Custom SMTP configuration - Use SSL/TLS from start for containerized environments
  const smtpConfig = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10000, // 10 seconds
    greetingTimeout: 10000, // 10 seconds
    socketTimeout: 10000, // 10 seconds
    tls: {
      rejectUnauthorized: false // Allow self-signed certificates
    }
  };
  
  console.log('📧 SMTP Configuration:', {
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    user: smtpConfig.auth.user,
    passwordSet: !!smtpConfig.auth.pass
  });
  
  return nodemailer.createTransport(smtpConfig);
};

// Send share link notification email
export const sendShareLinkEmail = async (recipientEmail, data) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.warn('Email credentials not configured. Skipping email notification.');
    return { success: false, message: 'Email not configured' };
  }

  try {
    const transporter = createTransporter();
    const shareUrl = data.shareUrl;
    const filename = data.filename;
    const senderName = data.senderName || 'VanishDrop User';
    const expiresAt = new Date(data.expiresAt).toLocaleString();
    const hasPassword = data.hasPassword || false;
    const maxOpens = data.maxOpens || 'Unlimited';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>File Shared with You</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
          .header h1 { margin: 0; font-size: 28px; }
          .content { padding: 30px; }
          .file-info { background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 5px; }
          .file-info p { margin: 8px 0; }
          .file-info strong { color: #667eea; }
          .cta-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; margin: 20px 0; font-weight: bold; box-shadow: 0 4px 15px rgba(102,126,234,0.4); }
          .cta-button:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102,126,234,0.6); }
          .security-note { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .security-note strong { color: #856404; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #6c757d; }
          .footer a { color: #667eea; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 VanishDrop</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Secure File Sharing</p>
          </div>
          <div class="content">
            <h2 style="color: #333; margin-top: 0;">Someone shared a file with you!</h2>
            <p>Hello! <strong>${senderName}</strong> has shared a file with you via VanishDrop.</p>
            
            <div class="file-info">
              <p><strong>📁 File:</strong> ${filename}</p>
              <p><strong>⏰ Expires:</strong> ${expiresAt}</p>
              <p><strong>🔄 Max Opens:</strong> ${maxOpens}</p>
              ${hasPassword ? '<p><strong>🔒 Password Protected:</strong> Yes (Contact sender for password)</p>' : ''}
            </div>

            <div style="text-align: center;">
              <a href="${shareUrl}" class="cta-button">
                📥 Download File
              </a>
            </div>

            ${hasPassword ? `
            <div class="security-note">
              <strong>⚠️ Password Required</strong><br>
              This file is password protected. Please contact the sender to get the password.
            </div>
            ` : ''}

            <div class="security-note">
              <strong>🔒 Security Notice</strong><br>
              This link will expire on ${expiresAt}. Download the file before it's automatically deleted.
            </div>

            <p style="margin-top: 30px; color: #6c757d; font-size: 14px;">
              If you don't recognize the sender or weren't expecting this file, please ignore this email.
            </p>
          </div>
          <div class="footer">
            <p>Sent by VanishDrop - Secure File Sharing</p>
            <p>
              <a href="${process.env.FRONTEND_URL}">Visit VanishDrop</a> | 
              <a href="${process.env.FRONTEND_URL}/privacy">Privacy Policy</a>
            </p>
            <p style="margin-top: 10px; color: #adb5bd;">
              This is an automated message, please do not reply.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"VanishDrop" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: `📁 ${senderName} shared "${filename}" with you`,
      html: htmlContent,
      text: `${senderName} shared a file with you via VanishDrop.\n\nFile: ${filename}\nExpires: ${expiresAt}\n${hasPassword ? 'Password Protected: Yes\n' : ''}\n\nDownload link: ${shareUrl}\n\nThis link will expire on ${expiresAt}.`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message };
  }
};

// Send file expiration reminder
export const sendExpirationReminder = async (recipientEmail, data) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    return { success: false, message: 'Email not configured' };
  }

  try {
    const transporter = createTransporter();
    const filename = data.filename;
    const expiresAt = new Date(data.expiresAt).toLocaleString();
    const hoursLeft = data.hoursLeft || 24;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ff6b6b; color: white; padding: 20px; text-align: center; border-radius: 5px; }
          .content { padding: 20px; background: #f8f9fa; margin-top: 20px; border-radius: 5px; }
          .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⏰ File Expiring Soon</h1>
          </div>
          <div class="content">
            <p>This is a reminder that your file <strong>"${filename}"</strong> will expire in approximately <strong>${hoursLeft} hours</strong>.</p>
            <div class="warning">
              <strong>Expiration Time:</strong> ${expiresAt}<br>
              After this time, the file will be permanently deleted from our servers.
            </div>
            <p>If you need to extend the file's availability, please upload it again.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"VanishDrop" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: `⏰ Your file "${filename}" expires in ${hoursLeft} hours`,
      html: htmlContent,
      text: `Your file "${filename}" will expire in ${hoursLeft} hours on ${expiresAt}. After this time, it will be permanently deleted.`,
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending expiration reminder:', error);
    return { success: false, error: error.message };
  }
};

// Send OTP email
export const sendOTPEmail = async (recipientEmail, otp) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    return { success: false, message: 'Email not configured' };
  }

  try {
    console.log('📧 Creating email transporter...');
    const transporter = createTransporter();
    console.log('📧 Transporter created successfully');

    console.log('📧 Preparing email content...');
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 5px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #667eea; text-align: center; padding: 30px; background: #f8f9fa; border-radius: 5px; letter-spacing: 8px; margin: 20px 0; }
          .warning { background: #fff3cd; padding: 15px; margin: 20px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Your VanishDrop OTP</h1>
          </div>
          <div class="otp-code">${otp}</div>
          <div class="warning">
            <strong>⚠️ Security Notice:</strong> This OTP will expire in 10 minutes. Never share this code with anyone.
          </div>
          <p>If you didn't request this code, please ignore this email.</p>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"VanishDrop" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: `🔐 Your VanishDrop OTP: ${otp}`,
      html: htmlContent,
      text: `Your VanishDrop OTP is: ${otp}\n\nThis code will expire in 10 minutes. Never share this code with anyone.`,
    };

    console.log('📧 Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('📧 Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('📧 Error sending OTP email:', error);
    console.error('📧 Error details:', {
      code: error.code,
      command: error.command,
      response: error.response,
      message: error.message
    });
    return { success: false, error: error.message };
  }
};

export default {
  sendShareLinkEmail,
  sendExpirationReminder,
  sendOTPEmail,
};

