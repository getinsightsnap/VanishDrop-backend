import { authenticator } from 'otplib';
import crypto from 'crypto';

// In-memory OTP storage (for production, use Redis or database)
const otpStorage = new Map();

// OTP Configuration
const OTP_EXPIRY = 10 * 60 * 1000; // 10 minutes in milliseconds
const OTP_LENGTH = 6;

// Generate a random 6-digit OTP
export const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

// Store OTP with expiry
export const storeOTP = (identifier, otp) => {
  const expiresAt = Date.now() + OTP_EXPIRY;
  otpStorage.set(identifier, {
    otp,
    expiresAt,
    attempts: 0
  });
  
  // Auto-cleanup after expiry
  setTimeout(() => {
    otpStorage.delete(identifier);
  }, OTP_EXPIRY);
  
  return expiresAt;
};

// Verify OTP
export const verifyOTP = (identifier, inputOTP) => {
  const stored = otpStorage.get(identifier);
  
  if (!stored) {
    return {
      valid: false,
      error: 'OTP not found or expired'
    };
  }
  
  // Check if expired
  if (Date.now() > stored.expiresAt) {
    otpStorage.delete(identifier);
    return {
      valid: false,
      error: 'OTP has expired'
    };
  }
  
  // Check attempts (max 3 attempts)
  if (stored.attempts >= 3) {
    otpStorage.delete(identifier);
    return {
      valid: false,
      error: 'Maximum verification attempts exceeded'
    };
  }
  
  // Increment attempts
  stored.attempts++;
  
  // Verify OTP
  if (stored.otp === inputOTP) {
    // Mark as verified but don't delete yet (will be deleted after file access)
    stored.verified = true;
    stored.verifiedAt = Date.now();
    return {
      valid: true,
      error: null
    };
  }
  
  return {
    valid: false,
    error: 'Invalid OTP',
    attemptsLeft: 3 - stored.attempts
  };
};

// Check if OTP was already verified and is still valid
export const isOTPVerified = (identifier) => {
  const stored = otpStorage.get(identifier);
  
  if (!stored) {
    return { verified: false, error: 'OTP not found or expired' };
  }
  
  // Check if expired
  if (Date.now() > stored.expiresAt) {
    otpStorage.delete(identifier);
    return { verified: false, error: 'OTP has expired' };
  }
  
  // Check if it was verified
  if (stored.verified) {
    return { verified: true, error: null };
  }
  
  return { verified: false, error: 'OTP not verified yet' };
};

// Delete OTP after successful file access
export const deleteOTP = (identifier) => {
  otpStorage.delete(identifier);
};

// Get OTP info (for debugging, remove in production)
export const getOTPInfo = (identifier) => {
  const stored = otpStorage.get(identifier);
  
  if (!stored) {
    return null;
  }
  
  return {
    exists: true,
    expiresAt: new Date(stored.expiresAt),
    attempts: stored.attempts,
    verified: stored.verified || false,
    timeLeft: Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000))
  };
};

// Clean all expired OTPs (cleanup job)
export const cleanupExpiredOTPs = () => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [identifier, data] of otpStorage.entries()) {
    if (now > data.expiresAt) {
      otpStorage.delete(identifier);
      cleaned++;
    }
  }
  
  return cleaned;
};

export default {
  generateOTP,
  storeOTP,
  verifyOTP,
  getOTPInfo,
  cleanupExpiredOTPs,
  OTP_EXPIRY,
  OTP_LENGTH
};

