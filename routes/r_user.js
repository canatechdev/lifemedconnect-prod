const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../lib/dbconnection');
const s_user = require('../services/s_user');
const { generateToken, verifyToken, hashPassword } = require('../lib/auth');
const { parsePaginationParams } = require('../lib/helpers');
const { asyncHandler } = require('../middleware/errorHandler');
const validateRequest = require('../middleware/validateRequest');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const axios = require('axios');
const { createWithApproval, updateWithApproval, deleteWithApproval, formatApprovalResponse } = require('../lib/approvalHelper');
const { getConfig } = require('../lib/config');

//  NEW: Import security middleware
const { loginLimiter, strictLimiter } = require('../middleware/security');

// NEW: Import permission system
const { getUserPermissions, requirePermission, hasPermission } = require('../lib/permissions');


// Joi schema for user registration
const registerSchema = Joi.object({
    username: Joi.string().min(3).max(30).optional(),
    mobile: Joi.string().pattern(/^[0-9]{10}$/).optional(),
    full_name: Joi.string().max(100).optional(),
    email: Joi.string().email().required(),
    password: Joi.string().min(4).required(),
    confirmPassword: Joi.string().min(4).optional(),
    role_id: Joi.number().integer().default(1) ,// 1=Admin, 2=TPA, 3=Center
    is_active: Joi.number().integer().valid(1,0).optional(),
    telephony_username: Joi.alternatives().try(
        Joi.string().max(100).optional(),
        Joi.string().allow('').optional()
    ).optional().allow(null),
    telephony_password: Joi.alternatives().try(
        Joi.string().max(255).optional(),
        Joi.string().allow('').optional()
    ).optional().allow(null)
});

// Joi schema for user login
const loginSchema = Joi.object({
    username: Joi.string().required(),
    password: Joi.string().required(),
    captchaToken: Joi.string().optional()
});

// Joi schema for user update
const updateSchema = Joi.object({
    username: Joi.string().min(3).max(30).optional(),
    mobile: Joi.string().pattern(/^[0-9]{10}$/).optional(),
    full_name: Joi.string().max(100).optional(),
    email: Joi.string().email().optional(),
    password: Joi.string().min(4).optional(),
    role_id: Joi.number().integer().positive().optional(),
     is_active: Joi.number().integer().valid(1,0).optional(),
    telephony_username: Joi.alternatives().try(
        Joi.string().max(100).optional(),
        Joi.string().allow('').optional()
    ).optional().allow(null),
    telephony_password: Joi.alternatives().try(
        Joi.string().max(255).optional(),
        Joi.string().allow('').optional()
    ).optional().allow(null)
});

const changePasswordSchema = Joi.object({
    new_password: Joi.string().min(4).required().label('New Password'),
    confirm_new_password: Joi.string().valid(Joi.ref('new_password')).required().label('Confirm Password')
        .messages({ 'any.only': 'Confirm Password must match New Password' }),
})

const deleteUsersSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).required()
});

// POST /api/auth/register
router.post('/auth/register', validateRequest(registerSchema), asyncHandler(async (req, res) => {
    const { username, email, password, role_id, mobile, full_name, telephony_username, telephony_password } = req.body;

    try {
        const userId = await s_user.addUser(username, email, password, role_id, mobile, full_name, telephony_username, telephony_password);
        logger.info('User registered', { userId, username });
        
        return ApiResponse.success(res, { userId }, 'User registered successfully', 201);
    } catch (error) {
        if (error.message === 'Username already exists') {
            return ApiResponse.conflict(res, 'Username already exists');
        }
        if (error.message === 'Email already exists') {
            return ApiResponse.conflict(res, 'Email already exists');
        }
        
        logger.error('Registration error', { error: error.message, username, email });
        return ApiResponse.error(res, 'Registration failed', 500);
    }
}));

// POST /api/auth/login
//  NEW: Apply login rate limiter (10 attempts per 15 minutes)
router.post('/auth/login', loginLimiter, validateRequest(loginSchema), asyncHandler(async (req, res) => {
    const { username, password, captchaToken } = req.body;
    const config = getConfig();

    // Verify the captcha token with Google only if enabled
    if (config.recaptcha.enabled) {
        if (!captchaToken) {
            return ApiResponse.forbidden(res, 'CAPTCHA token is required');
        }

        const secret = process.env.RECAPTCHA_SECRET_KEY;
        logger.info('Captcha verification start', {
            hasSecret: !!secret,
            tokenPreview: typeof captchaToken === 'string' ? `${captchaToken.substring(0, 8)}...` : 'invalid',
        });

        const captchaResponse = await axios.post(`https://www.google.com/recaptcha/api/siteverify`, null, {
            params: { secret, response: captchaToken },
        });

        if (!captchaResponse.data.success) {
            logger.warn('Captcha verification failed', {
                errorCodes: captchaResponse.data['error-codes'],
                hostname: captchaResponse.data.hostname,
                action: captchaResponse.data.action,
                remoteip: captchaResponse.data.remoteip,
                score: captchaResponse.data.score,
            });
            const reason = Array.isArray(captchaResponse.data['error-codes'])
                ? captchaResponse.data['error-codes'].join(', ')
                : 'Failed captcha verification';
            return ApiResponse.forbidden(res, reason);
        }
    }
    
    // Continue with user authentication
    const user = await s_user.getUserByUsername(username);
    if (!user) {
        // Check if user exists but is deleted/inactive for better error message
        const deletedUser = await db.query('SELECT id, is_deleted, is_active FROM users WHERE username = ? LIMIT 1', [username]);
        if (deletedUser.length > 0) {
            if (deletedUser[0].is_deleted === 1) {
                return ApiResponse.unauthorized(res, 'Account has been deleted');
            } else if (deletedUser[0].is_active === 0) {
                return ApiResponse.unauthorized(res, 'Account is inactive');
            }
        }
        return ApiResponse.unauthorized(res, 'Invalid credentials');
    }

    const isMatch = await s_user.comparePassword(password, user.password_hash);
    if (!isMatch) {
        return ApiResponse.unauthorized(res, 'Invalid credentials');
    }

    // NEW: Fetch user permissions
    const permissions = await getUserPermissions(user.id, user.role_id);

    // Prepare response object
    const userObj = {
        id: user.id,
        username: user.username,
        email: user.email,
        role_id: user.role_id,
        full_name: user.full_name,
        mobile: user.mobile,
        is_active: user.is_active,
        technician_id: user.technician_id,
        diagnostic_center_id: user.diagnostic_center_id,
        permissions  // NEW: Include permissions in response
    };

    const token = generateToken(userObj);
    logger.info('User logged in', { userId: user.id, username, permissionCount: permissions.length });
    
    return ApiResponse.success(res, { token, user: userObj }, 'Logged in successfully');
}));



// GET /api/users/me
router.get('/users/me', verifyToken, asyncHandler(async (req, res) => {
    const user = await s_user.getUserById(req.user.id);
    if (!user) {
        return ApiResponse.notFound(res, 'User not found');
    }
    return ApiResponse.success(res, user);
}));

// GET /api/users
router.get('/users/Get', verifyToken, requirePermission('users.view'), asyncHandler(async (req, res) => {
    const { page, limit, search, sortBy, sortOrder } = parsePaginationParams(req.query);

    const result = await s_user.getAllUsers({ 
        page, 
        limit, 
        search,
        sortBy,
        sortOrder
    });
    
    return ApiResponse.paginated(res, result.data, result.pagination);
}));



// POST /api/users/Add - Add new user
router.post('/users/Add', verifyToken, requirePermission('users.create'), validateRequest(registerSchema), asyncHandler(async (req, res) => {
   
   const { username, email, password, role_id, mobile, full_name } = req.body;

    try {
        // Check if user already exists (active users only)
        const existingUser = await s_user.checkUserExists(username, email);
        if (existingUser) {
            if (existingUser.username === username) {
                return ApiResponse.conflict(res, 'Username already exists');
            }
            if (existingUser.email === email) {
                return ApiResponse.conflict(res, 'Email already exists');
            }
        }

    const result = await createWithApproval({
        entity_type: 'user',
        createFunction: async (data) => await s_user.addUser(
            data.username,
            data.email,
            data.password,
            data.role_id,
            data.mobile,
            data.full_name
        ),
        data: { username, email, password, role_id, mobile, full_name },
        user: req.user,
        notes: req.body.approval_notes || '',
        priority: req.body.priority || 'medium'
    });

    const response = formatApprovalResponse(result);
    return ApiResponse.success(res, response, response.message, 201);
    } catch (error) {
        if (error.message === 'Username already exists') {
            return ApiResponse.conflict(res, 'Username already exists');
        }
        if (error.message === 'Email already exists') {
            return ApiResponse.conflict(res, 'Email already exists');
        }
        
        logger.error('User creation error', { error: error.message, username, email });
        return ApiResponse.error(res, 'User creation failed', 500);
    }
}));


// PUT /api/users/:id - Update user profile
router.put('/users/:id', verifyToken, validateRequest(updateSchema), asyncHandler(async (req, res) => {
   
     const targetUserId = parseInt(req.params.id, 10);
    const requester = req.user;

    // Allow update if has permission or user updating their own profile
    const canEditOthers = hasPermission(req.user.permissions || [], 'users.update');
    if (!canEditOthers && requester.id !== targetUserId) {
        return ApiResponse.forbidden(res, 'You cannot update this user');
    }

    const result = await updateWithApproval({
        entity_type: 'user',
        entity_id: targetUserId,
        getFunction: async (id) => await s_user.getUserById(id),
        updateFunction: async (id, data) => await s_user.updateUser(id, data),
        new_data: req.body,
        user: req.user,
        notes: req.body.approval_notes || '',
        priority: req.body.priority || 'medium'
    });

    const response = formatApprovalResponse(result);
    return ApiResponse.success(res, response, response.message);
   
    // const targetUserId = parseInt(req.params.id, 10);
    // const requester = req.user;

    // // Allow update if admin or user updating their own profile
    // if (requester.role_id !== 1 && requester.id !== targetUserId) {
    //     return ApiResponse.forbidden(res, 'You cannot update this user');
    // }

    // const user = await s_user.getUserById(targetUserId);
    // if (!user) {
    //     return ApiResponse.notFound(res, 'User not found');
    // }

    // await s_user.updateUser(targetUserId, req.body);
    // logger.info('User updated', { userId: targetUserId, updatedBy: requester.id });
    
    // return ApiResponse.success(res, { userId: targetUserId }, 'User updated successfully');
}));


// POST /api/users/delete - Soft delete users
router.post('/users/delete', verifyToken, requirePermission('users.delete'), validateRequest(deleteUsersSchema), asyncHandler(async (req, res) => {
    const results = [];

    for (const id of req.body.ids) {
        try {
            const result = await deleteWithApproval({
                entity_type: 'user',
                entity_id: id,
                getFunction: async (ids) => {
                    // Handle both single ID and array of IDs
                    if (Array.isArray(ids)) {
                        return await s_user.getUsersByIds(ids);
                    }
                    return await s_user.getUserById(ids);
                },
                deleteFunction: async (id) => await s_user.softDeleteUser([id]),
                user: req.user,
                notes: req.body.approval_notes || '',
                priority: req.body.priority || 'high'
            });

            results.push({ id, ...formatApprovalResponse(result) });
        } catch (error) {
            results.push({ id, error: error.message });
        }
    }

    const needsApproval = results.some(r => r.approval_required);
    const message = needsApproval
        ? 'Delete requests submitted for Super Admin approval'
        : 'Users deleted successfully';

    return ApiResponse.success(res, { results }, message);
   
    // const affected = await s_user.softDeleteUser(req.body.ids);
    // if (!affected) {
    //     return ApiResponse.notFound(res, 'No users were found or already deleted');
    // }

    // logger.info('Users soft deleted', { count: affected, deletedBy: req.user.id });
    // return ApiResponse.success(res, { updated: affected }, 'Users deleted successfully');
}));


// PUT /api/change-password/:id - Change user password
// NEW: Apply strict rate limiter (20 attempts per hour)
router.put('/change-password/:id', verifyToken, strictLimiter, validateRequest(changePasswordSchema), asyncHandler(async (req, res) => {
    const { new_password } = req.body;
    const targetUserId = parseInt(req.params.id, 10);
    const requester = req.user;

    // Only allow user with permission or the user themselves
    const canChangeOthersPassword = hasPermission(req.user.permissions || [], 'users.update');
    if (!canChangeOthersPassword && requester.id !== targetUserId) {
        return ApiResponse.forbidden(res, 'You cannot update this user\'s password');
    }

    const user = await s_user.getUserById(targetUserId);
    if (!user) {
        return ApiResponse.notFound(res, 'User not found');
    }

    await s_user.changePassword(targetUserId, new_password);
    logger.info('Password changed', { userId: targetUserId, changedBy: requester.id });

    return ApiResponse.success(res, null, 'Password updated successfully');
}));





module.exports = router;
