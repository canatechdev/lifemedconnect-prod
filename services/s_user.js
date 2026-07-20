const db = require('../lib/dbconnection');
const { hashPassword, comparePassword } = require('../lib/auth');

const addUser = async (username, email, password, role_id, mobile, full_name, telephony_username = null, telephony_password = null) => {
    const hashedPassword = await hashPassword(password);

    // Check if username or email already exists with active user (not soft-deleted)
    const existingActiveUserSql = 'SELECT id, username, email FROM users WHERE (username = ? OR email = ?) AND is_deleted = 0 LIMIT 1';
    const existingActiveUser = await db.query(existingActiveUserSql, [username, email]);
    
    if (existingActiveUser.length > 0) {
        // Check what specifically conflicts
        const existing = existingActiveUser[0];
        if (existing.username === username) {
            throw new Error('Username already exists');
        }
        if (existing.email === email) {
            throw new Error('Email already exists');
        }
    }

    // Check if there's a soft-deleted user with same username/email to clean up
    const existingSoftDeletedSql = 'SELECT id FROM users WHERE (username = ? OR email = ?) AND is_deleted = 1 LIMIT 1';
    const existingSoftDeleted = await db.query(existingSoftDeletedSql, [username, email]);
    
    if (existingSoftDeleted.length > 0) {
        // Permanently delete the soft-deleted user to allow reuse
        const cleanupSql = 'DELETE FROM users WHERE id = ?';
        await db.query(cleanupSql, [existingSoftDeleted[0].id]);
    }

    const sql = `
      INSERT INTO users (username, email, password_hash, role_id, full_name, mobile, telephony_username, telephony_password, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`;
    const result = await db.query(sql, [username, email, hashedPassword, role_id, full_name || null, mobile || null, telephony_username || null, telephony_password || null]);
    return result.insertId;
};

// Helper function to check if user exists (for validation)
const checkUserExists = async (username, email, excludeId = null) => {
    let sql = 'SELECT id, username, email FROM users WHERE (username = ? OR email = ?) AND is_deleted = 0';
    let params = [username, email];
    
    if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
    }
    
    sql += ' LIMIT 1';
    
    const existing = await db.query(sql, params);
    return existing[0] || null;
};

const getUserByUsername = async (username) => {
    const sql = `
        SELECT 
            u.*, 
            t.id AS technician_id,
            t.technician_type,
            t.rate_per_appointment,
            t.profile_pic,
            dc.id AS diagnostic_center_id,
            dc.center_name
        FROM users u
        LEFT JOIN technicians t ON u.id = t.user_id AND t.is_deleted = 0
        LEFT JOIN diagnostic_centers dc ON u.id = dc.user_id AND dc.is_deleted = 0
        WHERE u.username = ? AND u.is_deleted = 0 AND u.is_active = 1
        LIMIT 1
    `;

    const users = await db.query(sql, [username]);
    return users[0];
};


const getUserById = async (id) => {
    const sql = `
      SELECT id, username, email, role_id, full_name, mobile, telephony_username, telephony_password, is_active, last_login, created_at, updated_at 
      FROM users 
      WHERE id = ?`;
    const users = await db.query(sql, [id]);
    return users[0];
};

// Get multiple users by IDs (for bulk operations like delete)
const getUsersByIds = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const sql = `
      SELECT id, username, email, role_id, full_name, mobile, telephony_username, telephony_password, is_active, last_login, created_at, updated_at 
      FROM users 
      WHERE id IN (${placeholders})`;
    const users = await db.query(sql, ids);
    return users;
};



const getAllUsers = async ({ page = 1, limit = 0, search = '', sortBy = 'id', sortOrder = 'DESC' }) => {
    const searchColumns = ['username', 'email', 'full_name', 'mobile'];
    const searchParams = [];
    let whereClause = ' WHERE is_deleted = 0 AND has_pending_approval=0';

    if (search.trim() !== '') {
        const searchConditions = searchColumns.map(col => `${col} LIKE ?`).join(' OR ');
        whereClause += ` AND (${searchConditions})`;
        searchColumns.forEach(() => searchParams.push(`%${search}%`));
    }

    // Validate sortBy to prevent SQL injection
    const allowedSortColumns = [
        'id',
        'username',
        'email',
        'full_name',
        'mobile',
        'is_active',
        'last_login',
        'created_at'
    ];
    const validSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'id';
    const validSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Count total
    const countSql = `SELECT COUNT(*) as total FROM users${whereClause}`;
    const countRows = await db.query(countSql, searchParams);
    const total = countRows[0].total;

    // Paginated query with sorting
    let dataSql = `
        SELECT id, username, email, role_id, full_name, mobile, telephony_username, telephony_password, is_active, last_login, created_at, updated_at 
        FROM users${whereClause}
        ORDER BY ${validSortBy} ${validSortOrder}
    `;

    const dataParams = [...searchParams];

    const numericLimit = Number(limit);
    const numericPage = Number(page);

    if (!isNaN(numericLimit) && numericLimit > 0) {
        const offset = (numericPage - 1) * numericLimit;
        dataSql += ` LIMIT ${numericLimit} OFFSET ${offset}`;
    }

    const rows = await db.query(dataSql, dataParams);

    return {
        data: rows,
        pagination: {
            total,
            page: numericPage,
            limit: numericLimit,
            pages: numericLimit > 0 ? Math.ceil(total / numericLimit) : 1,
        },
    };
};



const updateUser = async (id, data) => {
    const fields = [];
    const values = [];

    if (data.email) {
        fields.push("email = ?");
        values.push(data.email);
    }
    if (data.full_name) {
        fields.push("full_name = ?");
        values.push(data.full_name);
    }
    if (data.mobile) {
        fields.push("mobile = ?");
        values.push(data.mobile);
    }
    if (data.username) {
        fields.push("username = ?");
        values.push(data.username);
    }
    if (typeof data.role_id === 'number') {
        fields.push("role_id = ?");
        values.push(data.role_id);
    }
    if (typeof data.is_active === 'number') {
        fields.push("is_active = ?");
        values.push(data.is_active);
    }

    // Handle telephony credentials
    if (data.hasOwnProperty('telephony_username')) {
        fields.push("telephony_username = ?");
        values.push(data.telephony_username || null);
    }
    if (data.hasOwnProperty('telephony_password')) {
        fields.push("telephony_password = ?");
        values.push(data.telephony_password || null);
    }

    // Only hash and update password if it's non-empty
    if (typeof data.password === 'string' && data.password.trim() !== '') {
        const hashedPassword = await hashPassword(data.password);
        fields.push("password_hash = ?");
        values.push(hashedPassword);
    }

    if (fields.length === 0) {
        throw new Error("No valid fields to update");
    }

    fields.push("updated_at = NOW()");
    const sql = `UPDATE users SET ${fields.join(", ")} WHERE id = ?`;
    values.push(id);

    await db.query(sql, values);
    return id;
};


// softdelete user

const softDeleteUser = async (ids) => {
    if (!ids.length) return 0;

    const placeholders = ids.map(() => '?').join(', ');
    const sql = `UPDATE users SET is_deleted = 1, updated_at = NOW() WHERE id IN (${placeholders})`;

    const result = await db.query(sql, ids);

    return result.affectedRows;
}



// change password

const changePassword = async (id, plainPassword) => {
    const hashedPassword = await hashPassword(plainPassword);
    const sql = `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`;
    await db.query(sql, [hashedPassword, id]);
    return id;
};


module.exports = {
    addUser,
    getUserByUsername,
    getUserById,
    getUsersByIds,
    getAllUsers,
    comparePassword,
    updateUser,
    changePassword,
    softDeleteUser,
    checkUserExists
};
