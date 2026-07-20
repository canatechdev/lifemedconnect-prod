const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const bcrypt = require('bcryptjs');
const { generateToken, comparePassword } = require('../../lib/auth');
const userService = require('../s_user');
const emailService = require('../../lib/emailService');

const TECHNICIAN_ROLE_ID = 4; // current technician role
const CENTER_ROLE_ID = 3; // diagnostic center role
const ALLOWED_APP_ROLES = [TECHNICIAN_ROLE_ID, CENTER_ROLE_ID];

// Get OTP expiry from ENV or default to 10 minutes
function getOtpExpiryMinutes() {
    return Number(process.env.OTP_EXPIRY_MINUTES) || 10;
}

// Mask email address for security (show last 4-5 chars before @)
function maskEmail(email) {
    if (!email) return '';
    const [localPart, domain] = email.split('@');
    if (!domain) return email;
    
    const visibleChars = Math.min(5, Math.max(4, localPart.length - 2));
    const maskedPart = '*'.repeat(Math.max(0, localPart.length - visibleChars));
    const visiblePart = localPart.slice(-visibleChars);
    
    return `${maskedPart}${visiblePart}@${domain}`;
}

function mapUserResponse(user) {
    const baseUrl = global.BASE_URL || '';
    const isCenter = Number(user.role_id) === CENTER_ROLE_ID;
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        mobile: user.mobile,
        role_id: user.role_id,
        user_type: isCenter ? 'center' : 'technician',
        technician_id: user.technician_id || null,
        technician_type: user.technician_type || null,
        rate_per_appointment: user.rate_per_appointment ? Number(user.rate_per_appointment) : 0,
        profile_pic: user.profile_pic ? `${baseUrl}/${user.profile_pic.replace(/\\/g, '/')}` : null,
        diagnostic_center_id: user.diagnostic_center_id || null,
        center_name: user.center_name || null,
    };
}


function isOtpEmailEnabled() {
    const flag = (process.env.EMAIL_ENABLED ?? 'true').toString().toLowerCase();
    return flag === 'true' || flag === '1';
}

// Hash OTP for secure storage
async function hashOtp(otp) {
    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 10;
    return await bcrypt.hash(otp, saltRounds);
}

// Verify OTP against hash
async function verifyOtp(otp, hash) {
    return await bcrypt.compare(otp, hash);
}



async function login({ username, password }) {
    const user = await userService.getUserByUsername(username);
    if (!user) {
        return { success: false, message: 'Invalid username or password' };
    }

    if (!ALLOWED_APP_ROLES.includes(Number(user.role_id))) {
        return { success: false, message: 'Access denied for this user role' };
    }

    if (Number(user.is_active) === 0) {
        return { success: false, message: 'User is inactive' };
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
        return { success: false, message: 'Invalid username or password' };
    }

    // Update last_login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = generateToken(user);

    return {
        success: true,
        token,
        user: mapUserResponse(user),
    };
}

async function changePassword({ userId, oldPassword, newPassword }) {
    const rows = await db.query(
        'SELECT id, role_id, is_active, password_hash FROM users WHERE id = ? AND is_deleted = 0 LIMIT 1',
        [userId]
    );
    const user = rows[0];
    if (!user) {
        throw new Error('User not found');
    }
    if (!ALLOWED_APP_ROLES.includes(Number(user.role_id))) {
        return { success: false, message: 'Access denied for this user role' };
    }
    if (Number(user.is_active) === 0) {
        return { success: false, message: 'User is inactive' };
    }

    const match = await comparePassword(oldPassword, user.password_hash);
    if (!match) {
        return { success: false, message: 'Old password is incorrect' };
    }

    await userService.changePassword(userId, newPassword);
    return { success: true };
}

// OTP helpers
async function createOtpRecord(userId, purpose = 'password_reset', ipAddress = null) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await hashOtp(otp);
    const expiryMinutes = getOtpExpiryMinutes();
    
    await db.query(
        `INSERT INTO user_otps (user_id, otp_code, otp_hash, purpose, expires_at, ip_address, created_at) 
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, NOW())`,
        [userId, otp, otpHash, purpose, expiryMinutes, ipAddress]
    );
    return otp;
}

async function getActiveOtp(userId, otp, purpose = 'password_reset') {
    // Get all active OTPs for this user and purpose
    const rows = await db.query(
        `SELECT id, otp_code, otp_hash, expires_at, used_at 
         FROM user_otps 
         WHERE user_id = ? AND purpose = ? 
           AND used_at IS NULL AND expires_at > NOW()
         ORDER BY id DESC`,
        [userId, purpose]
    );
    
    // Check each OTP (prioritize hashed ones)
    for (const row of rows) {
        if (row.otp_hash) {
            // Use bcrypt comparison for hashed OTPs
            const isValid = await verifyOtp(otp, row.otp_hash);
            if (isValid) return row;
        } else if (row.otp_code === otp) {
            // Fallback to plain text comparison for legacy OTPs
            return row;
        }
    }
    
    return null;
}

async function markOtpUsed(id) {
    await db.query('UPDATE user_otps SET used_at = NOW() WHERE id = ?', [id]);
}

async function sendOtpEmail(to, otp) {
    if (!isOtpEmailEnabled()) {
        logger.info('OTP email sending skipped (EMAIL_ENABLED=false)', { to });
        return;
    }

    const expiryMinutes = getOtpExpiryMinutes();
    try {
        const resp = await emailService.sendOtpEmail(to, otp, expiryMinutes);
        if (!resp?.success) {
            logger.error('OTP email send failed', {
                to,
                message: resp?.message,
                code: resp?.code,
                response: resp?.response
            });
            throw new Error('OTP_EMAIL_SEND_FAILED');
        }
    } catch (error) {
        logger.error('OTP email send failed', {
            to,
            error: error?.message,
            code: error?.code
        });
        throw new Error('OTP_EMAIL_SEND_FAILED');
    }
}

async function requestOtp({ username, userId, ipAddress = null }) {
    let user;
    if (userId) {
        const rows = await db.query(
            `SELECT 
                u.*, 
                t.id AS technician_id, 
                t.technician_type,
                t.rate_per_appointment,
                t.profile_pic,
                dc.id AS diagnostic_center_id 
             FROM users u 
             LEFT JOIN technicians t ON u.id = t.user_id AND t.is_deleted = 0 
             LEFT JOIN diagnostic_centers dc ON u.id = dc.user_id AND dc.is_deleted = 0 
             WHERE u.id = ? 
             LIMIT 1`,
            [userId]
        );
        user = rows[0];
    } else if (username) {
        user = await userService.getUserByUsername(username);
    }

    if (!user) {
        return { success: false, message: 'User not found' };
    }
    if (Number(user.is_active) === 0) {
        return { success: false, message: 'User is inactive' };
    }

    const otp = await createOtpRecord(user.id, 'password_reset', ipAddress);

    // Send OTP via email if configured
    if (user.email) {
        try {
            await sendOtpEmail(user.email, otp);
        } catch (error) {
            return {
                success: false,
                message: 'Failed to send OTP email. Please try again or contact support.'
            };
        }
    } else {
        logger.warn('User has no email, OTP not sent', { userId: user.id });
        return { success: false, message: 'User has no email address configured' };
    }

    logger.info('OTP generated', { userId: user.id, username: user.username });
    
    // Only return OTP in development mode
    const isDev = process.env.NODE_ENV !== 'production';
    return { 
        success: true, 
        message: 'OTP sent to your registered email',
        masked_email: maskEmail(user.email),
        ...(isDev && { otp_dev: otp })
    };
}

async function resetPasswordWithOtp({ username, userId, otp, newPassword }) {
    let user;
    if (userId) {
        const rows = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
        user = rows[0];
    } else if (username) {
        user = await userService.getUserByUsername(username);
    }

    if (!user) {
        return { success: false, message: 'User not found' };
    }

    const otpRow = await getActiveOtp(user.id, otp);
    if (!otpRow) {
        return { success: false, message: 'Invalid or expired OTP' };
    }

    await userService.changePassword(user.id, newPassword);
    await markOtpUsed(otpRow.id);

    return { success: true };
}

module.exports = {
    login,
    changePassword,
    requestOtp,
    resetPasswordWithOtp,
};
