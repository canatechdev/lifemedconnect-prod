const db = require('../lib/dbconnection');
const BaseService = require('../lib/baseService');
const logger = require('../lib/logger');
const { generateCustomCode } = require('../lib/generateCode');

/**
 * Service layer for diagnostic centers management
 * Extends BaseService for standard CRUD operations
 */
class CentersService extends BaseService {
  constructor() {
    super(
      'diagnostic_centers',
      'id',
      // Searchable columns (only existing DB columns)
      ['center_name', 'center_code', 'contact_number', 'email', 'address', 'city', 'state', 'pincode', 'country', 'owner_name'],
      // Select columns for list responses
      ['id', 'center_name', 'center_code', 'contact_number', 'email', 'address', 'city', 'state', 'pincode', 'country', 'owner_name', 'is_active', 'created_at']
    );
  }

  /**
   * Create a new center
   * @param {Object} data - Center data
   * @param {number} createdBy - User ID creating the center
   * @param {Object} connection - Optional database connection for transactions
   * @returns {Promise<number>} Inserted center ID
   */
  async createCenter(data, createdBy = null, connection = null) {
    try {
      logger.info('Creating center', { center_name: data.center_name, createdBy });

      // Generate center code if not provided
      if (!data.center_code) {
        data.center_code = await generateCustomCode({
          prefix: 'DC',
          table: 'diagnostic_centers',
          column: 'center_code'
        });
      }

      // Prepare center data with safe defaults. Do NOT include created_by here,
      // BaseService.create will append created_by using the createdBy argument.
      const centerData = {
        user_id: data.user_id ?? null,
        center_code: data.center_code,
        center_name: data.center_name,
        center_type: data.center_type ?? null,
        address: data.address ?? null,
        owner_name: data.owner_name ?? null,
        contact_number: data.contact_number ?? null,
        email: data.email ?? null,
        city: data.city ?? null,
        city_type: data.city_type ?? null,
        state: data.state ?? null,
        pincode: data.pincode ?? null,
        country: data.country ?? null,
        dc_photos: data.dc_photos ?? null,
        gps_latitude: data.gps_latitude ?? null,
        gps_longitude: data.gps_longitude ?? null,
        service_radius_km: data.service_radius_km ?? null,
        extra_charge_per_km: data.extra_charge_per_km ?? null,
        letterhead_path: data.letterhead_path ?? null,
        footer_path: data.footer_path ?? null,
        is_active: data.is_active !== undefined ? data.is_active : 1,
        associate_doctor_1_id: data.associate_doctor_1_id ?? null,
        associate_doctor_2_id: data.associate_doctor_2_id ?? null,
        associate_doctor_3_id: data.associate_doctor_3_id ?? null,
        associate_doctor_4_id: data.associate_doctor_4_id ?? null,
        acc_name: data.acc_name ?? null,
        acc_no: data.acc_no ?? null,
        ifsc_code: data.ifsc_code ?? null,
        receivers_name: data.receivers_name ?? null,
        branch_name: data.branch_name ?? null,
        accredation: data.accredation ?? null
      };

      const effectiveCreatedBy = createdBy ?? data.created_by ?? null;
      const result = await this.create(centerData, effectiveCreatedBy, connection);
      
      logger.info('Center created successfully', { 
        centerId: result, 
        center_code: centerData.center_code,
        center_name: centerData.center_name 
      });
      
      return result;
    } catch (error) {
      logger.error('Error creating center', {
        center_name: data.center_name,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to create center: ${error.message}`);
    }
  }

  /**
   * List centers with pagination and search
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Paginated results
   */
  async listCenters(options = {}) {
    const { page = 1, limit = 10, search = '', sortBy = 'id', sortOrder = 'DESC' } = options;
    
    try {
      logger.info('Listing centers', { page, limit, search: search || 'none', sortBy, sortOrder });
      
      const result = await this.list({ page, limit, search, sortBy, sortOrder });
      
      logger.info('Centers listed successfully', { 
       total: result.pagination?.total ?? result.data.length,
        page: result.pagination?.page ?? null,
        returned: result.data.length
      });
      
      return result;
    } catch (error) {
      logger.error('Error listing centers', { 
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to list centers: ${error.message}`);
    }
  }

  /**
   * Get a single center by ID
   * @param {number} id - Center ID
   * @returns {Promise<Object|null>} Center object or null if not found
   */
  async getCenter(id) {
    try {
      logger.info('Fetching center', { centerId: id });
      
      const center = await this.findById(id);
      
      if (!center) {
        logger.warn('Center not found', { centerId: id });
        return null;
      }
      
      logger.info('Center fetched successfully', { centerId: id, center_name: center.center_name });
      return center;
    } catch (error) {
      logger.error('Error fetching center', { 
        centerId: id,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to fetch center: ${error.message}`);
    }
  }

  /**
   * Get multiple centers by IDs
   * @param {Array<number>} ids - Array of center IDs
   * @returns {Promise<Array>} Array of center objects
   */
  async getCentersByIds(ids) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        logger.warn('getCentersByIds called with empty or invalid IDs');
        return [];
      }
      
      logger.info('Fetching centers by IDs', { count: ids.length });
      const centers = await this.findByIds(ids);
      
      logger.info('Centers fetched by IDs successfully', {
        requested: ids.length,
        found: centers.length
      });
      
      return centers;
    } catch (error) {
      logger.error('Error fetching centers by IDs', {
        count: ids.length,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to fetch centers by IDs: ${error.message}`);
    }
  }

  /**
   * Update a center
   * @param {number} id - Center ID
   * @param {Object} data - Update data
   * @param {number} updatedBy - User ID updating the center
   * @param {Object} connection - Optional database connection for transactions
   * @returns {Promise<number>} Number of affected rows
   */
  async updateCenter(id, data, updatedBy = null, connection = null) {
    try {
      logger.info('Updating center', { centerId: id, updatedBy });
      
      const affectedRows = await this.update(id, data, updatedBy, connection);
      
      if (affectedRows === 0) {
        logger.warn('Center not found for update', { centerId: id });
        return 0;
      }
      
      logger.info('Center updated successfully', { centerId: id, affectedRows });
      return affectedRows;
    } catch (error) {
      logger.error('Error updating center', {
        centerId: id,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to update center: ${error.message}`);
    }
  }

  /**
   * Soft delete centers (mark as deleted)
   * @param {Array<number>} ids - Array of center IDs
   * @param {number} deletedBy - User ID deleting the centers
   * @param {Object} connection - Optional database connection for transactions
   * @returns {Promise<number>} Number of affected rows
   */
  async softDeleteCenters(ids, deletedBy = null, connection = null) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        logger.warn('softDeleteCenters called with empty or invalid IDs');
        return 0;
      }
      
      logger.info('Soft deleting centers', { count: ids.length, deletedBy });
      const affectedRows = await this.softDelete(ids, deletedBy, connection);
      
      logger.info('Centers soft deleted successfully', {
        requested: ids.length,
        deleted: affectedRows
      });
      
      return affectedRows;
    } catch (error) {
      logger.error('Error soft deleting centers', {
        count: ids.length,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to soft delete centers: ${error.message}`);
    }
  }

  /**
   * Hard delete a center (permanent deletion)
   * @param {number} id - Center ID
   * @returns {Promise<number>} Number of affected rows
   */
  async deleteCenter(id) {
    try {
      logger.warn('Permanently deleting center', { centerId: id });
      
      const affectedRows = await this.delete(id);
      
      if (affectedRows === 0) {
        logger.warn('Center not found for permanent deletion', { centerId: id });
        return 0;
      }
      
      logger.warn('Center permanently deleted', { centerId: id });
      return affectedRows;
    } catch (error) {
      logger.error('Error permanently deleting center', {
        centerId: id,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to delete center: ${error.message}`);
    }
  }
}

// Initialize service instance
const centersService = new CentersService();

module.exports = {
  CentersService,
  createCenter: centersService.createCenter.bind(centersService),
  listCenters: centersService.listCenters.bind(centersService),
  getCenter: centersService.getCenter.bind(centersService),
  getCentersByIds: centersService.getCentersByIds.bind(centersService),
  updateCenter: centersService.updateCenter.bind(centersService),
  deleteCenter: centersService.deleteCenter.bind(centersService),
  softDeleteCenters: centersService.softDeleteCenters.bind(centersService)
};
