import dotenv from 'dotenv';

dotenv.config();

// Dynamic import for SendGrid to handle missing package gracefully
let sgMail = null;
let sendGridAvailable = false;

try {
  const sendGridModule = await import('@sendgrid/mail');
  sgMail = sendGridModule.default;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  sendGridAvailable = true;
  console.log('✅ SendGrid package loaded successfully');
} catch (error) {
  console.error('❌ SendGrid package not available:', error.message);
  console.log('📧 Email functionality will be limited until SendGrid is installed');
}

// SendGrid is now the primary email service
// No need for nodemailer transporter since we're using SendGrid SDK
// Railway will install @sendgrid/mail package automatically

// Send share link notification email
export const sendShareLinkEmail = async (recipientEmail, data) => {
  if (!sendGridAvailable) {
    console.warn('SendGrid package not available. Skipping email notification.');
    return { success: false, message: 'SendGrid package not installed' };
  }
  
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('SendGrid API key not configured. Skipping email notification.');
    return { success: false, message: 'Email not configured' };
  }

  try {
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

    const msg = {
      to: recipientEmail,
      from: process.env.EMAIL_FROM || 'noreply@vanishdrop.com',
      subject: `📁 ${senderName} shared "${filename}" with you`,
      html: htmlContent,
      text: `${senderName} shared a file with you via VanishDrop.\n\nFile: ${filename}\nExpires: ${expiresAt}\n${hasPassword ? 'Password Protected: Yes\n' : ''}\n\nDownload link: ${shareUrl}\n\nThis link will expire on ${expiresAt}.`,
    };

    const response = await sgMail.send(msg);
    console.log('Email sent successfully via SendGrid:', response[0].statusCode);
    return { success: true, messageId: response[0].headers['x-message-id'] };
  } catch (error) {
    console.error('Error sending email via SendGrid:', error);
    return { success: false, error: error.message };
  }
};

// Send file expiration reminder
export const sendExpirationReminder = async (recipientEmail, data) => {
  if (!sendGridAvailable) {
    console.warn('SendGrid package not available. Skipping email notification.');
    return { success: false, message: 'SendGrid package not installed' };
  }
  
  if (!process.env.SENDGRID_API_KEY) {
    return { success: false, message: 'SendGrid API key not configured' };
  }

  try {
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

    const msg = {
      to: recipientEmail,
      from: process.env.EMAIL_FROM || 'noreply@vanishdrop.com',
      subject: `⏰ Your file "${filename}" expires in ${hoursLeft} hours`,
      html: htmlContent,
      text: `Your file "${filename}" will expire in ${hoursLeft} hours on ${expiresAt}. After this time, it will be permanently deleted.`,
    };

    const response = await sgMail.send(msg);
    return { success: true, messageId: response[0].headers['x-message-id'] };
  } catch (error) {
    console.error('Error sending expiration reminder via SendGrid:', error);
    return { success: false, error: error.message };
  }
};

// Send OTP email
export const sendOTPEmail = async (recipientEmail, otp) => {
  if (!sendGridAvailable) {
    console.warn('SendGrid package not available. Skipping OTP email.');
    return { success: false, message: 'SendGrid package not installed' };
  }
  
  if (!process.env.SENDGRID_API_KEY) {
    return { success: false, message: 'SendGrid API key not configured' };
  }

  try {
    console.log('📧 Preparing SendGrid email...');
    
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

    const msg = {
      to: recipientEmail,
      from: process.env.EMAIL_FROM || 'noreply@vanishdrop.com',
      subject: `🔐 Your VanishDrop OTP: ${otp}`,
      text: `Your VanishDrop OTP is: ${otp}\n\nThis code will expire in 10 minutes. Never share this code with anyone.`,
      html: htmlContent,
    };

    console.log('📧 Sending email via SendGrid...');
    const response = await sgMail.send(msg);
    console.log('📧 Email sent successfully via SendGrid:', response[0].statusCode);
    return { success: true, messageId: response[0].headers['x-message-id'] };
  } catch (error) {
    console.error('📧 Error sending OTP email via SendGrid:', error);
    console.error('📧 Error details:', {
      code: error.code,
      message: error.message,
      response: error.response?.body
    });
    return { success: false, error: error.message };
  }
};

// Send document request email to recipient
export const sendDocumentRequestEmail = async (recipientEmail, requesterName, message, requestToken, deadline) => {
  if (!sendGridAvailable) {
    console.warn('SendGrid not available, skipping document request email');
    return { success: false, message: 'SendGrid package not installed' };
  }

  const requestUrl = `${process.env.FRONTEND_URL || 'https://vanishdrop.com'}/fulfill/${requestToken}`;
  const deadlineText = deadline ? `\nDeadline: ${new Date(deadline).toLocaleString()}` : '';

  const msg = {
    to: recipientEmail,
    from: process.env.EMAIL_FROM || 'noreply@vanishdrop.com',
    subject: `${requesterName} has requested a document from you`,
    text: `
Hello,

${requesterName} has requested a document from you.

Message:
${message}
${deadlineText}

Please click the link below to upload the requested document:
${requestUrl}

If you don't have an account, you'll be prompted to create one.

Best regards,
VanishDrop Team
    `,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #333;">Document Request</h2>
  <p>Hello,</p>
  <p><strong>${requesterName}</strong> has requested a document from you.</p>
  
  <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <p style="margin: 0;"><strong>Message:</strong></p>
    <p style="margin: 10px 0 0 0;">${message}</p>
    ${deadline ? `<p style="margin: 10px 0 0 0;"><strong>Deadline:</strong> ${new Date(deadline).toLocaleString()}</p>` : ''}
  </div>
  
  <p>Please click the button below to upload the requested document:</p>
  
  <a href="${requestUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0;">
    Upload Document
  </a>
  
  <p style="color: #666; font-size: 14px;">If you don't have an account, you'll be prompted to create one.</p>
  
  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    If the button doesn't work, copy and paste this link into your browser:<br>
    ${requestUrl}
  </p>
  
  <p>Best regards,<br>VanishDrop Team</p>
</div>
    `
  };

  try {
    console.log('📧 Attempting to send document request email to:', recipientEmail);
    console.log('📧 Preparing SendGrid email...');
    console.log('📧 Sending email via SendGrid...');
    
    const response = await sgMail.send(msg);
    
    console.log('📧 Email sent successfully via SendGrid:', response[0].statusCode);
    return { success: true, messageId: response[0].headers['x-message-id'] };
  } catch (error) {
    console.error('📧 Error sending document request email:', error);
    console.error('📧 Error details:', {
      code: error.code,
      message: error.message,
      response: error.response?.body
    });
    return { success: false, error: error.message };
  }
};

// Send request fulfilled notification to requester
export const sendRequestFulfilledEmail = async (requesterEmail, recipientName, shareToken) => {
  if (!sendGridAvailable) {
    console.warn('SendGrid not available, skipping fulfillment email');
    return { success: false, message: 'SendGrid package not installed' };
  }

  const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/share/${shareToken}`;

  const msg = {
    to: requesterEmail,
    from: process.env.EMAIL_FROM || 'noreply@vanishdrop.com',
    subject: 'Your document request has been fulfilled',
    text: `
Hello,

Good news! ${recipientName} has uploaded the document you requested.

You can now access the document here:
${shareUrl}

Best regards,
VanishDrop Team
    `,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #333;">✅ Document Request Fulfilled</h2>
  <p>Hello,</p>
  <p>Good news! <strong>${recipientName}</strong> has uploaded the document you requested.</p>
  
  <p>You can now access the document by clicking the button below:</p>
  
  <a href="${shareUrl}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0;">
    View Document
  </a>
  
  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    If the button doesn't work, copy and paste this link into your browser:<br>
    ${shareUrl}
  </p>
  
  <p>Best regards,<br>VanishDrop Team</p>
</div>
    `
  };

  try {
    console.log('📧 Sending fulfillment notification to:', requesterEmail);
    const response = await sgMail.send(msg);
    console.log('📧 Fulfillment email sent successfully:', response[0].statusCode);
    return { success: true, messageId: response[0].headers['x-message-id'] };
  } catch (error) {
    console.error('📧 Error sending fulfillment email:', error);
    return { success: false, error: error.message };
  }
};

export default {
  sendShareLinkEmail,
  sendExpirationReminder,
  sendOTPEmail,
  sendDocumentRequestEmail,
  sendRequestFulfilledEmail,
};

