/**
 * SparkTG Socket Service
 * Connects to SparkTG WebSocket for real-time call events
 * Broadcasts events to CRM clients via Socket.IO
 */

const WebSocket = require('ws');
const logger = require('../../lib/logger');
const { query } = require('../../lib/dbconnection');
const { TPAWebhookService } = require('../tpa');

class SparkTGSocketService {
    constructor() {
        this.ws = null;
        this.io = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.isConnected = false;
        this.serviceId = process.env.TELEPHONY_SERVICE_ID;
        this.socketHost = process.env.TELEPHONY_SOCKET_HOST || 'telephonycloud.co.in';
        this.socketPort = process.env.TELEPHONY_SOCKET_PORT || 8997;
        this.eventMask = process.env.TELEPHONY_EVENT_MASK || '1111111111';
        this.enabled = process.env.TELEPHONY_SOCKET_ENABLED === 'true';
        
        // Generate service key from UUID (not Basic Auth)
        // SparkTG requires a service UUID key, not username:password
        this.serviceKey = process.env.TELEPHONY_API_TOKEN || '20d9dece-b076-49d5-8615-1f31959a1c8d'; // Default to provided UUID
    }

    /**
     * Generate service key for SparkTG authentication
     */
    generateServiceKey() {
        // No need to generate service key, using UUID directly
        return this.serviceKey;
    }

    /**
     * Initialize the socket service with Socket.IO instance
     */
    initialize(io) {
        this.io = io;
        
        logger.info('=== SparkTG Socket Service Initialization ===', {
            enabled: this.enabled,
            hasServiceId: !!this.serviceId,
            hasServiceKey: !!this.serviceKey,
            serviceId: this.serviceId,
            socketHost: this.socketHost,
            socketPort: this.socketPort
        });
        
        if (!this.enabled) {
            logger.warn('SparkTG Socket Service is DISABLED (TELEPHONY_SOCKET_ENABLED != true)');
            return;
        }

        if (!this.serviceId || !this.serviceKey) {
            logger.error('SparkTG Socket Service: Missing service ID or key', {
                serviceId: this.serviceId,
                hasServiceKey: !!this.serviceKey
            });
            return;
        }

        logger.info('Starting SparkTG WebSocket connection...');
        this.connect();
    }

    /**
     * Connect to SparkTG WebSocket
     */
    connect() {
        try {
            const wsUrl = `ws://${this.socketHost}:${this.socketPort}`;
            
            logger.info('Connecting to SparkTG WebSocket', { 
                url: wsUrl,
                serviceId: this.serviceId 
            });

            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                logger.info('SparkTG WebSocket CONNECTED successfully');
                
                // Send authentication key
                // Convert decimal event mask to binary string
                // 1023 decimal = 1111111111 binary (all events)
                const eventMaskBinary = parseInt(this.eventMask).toString(2).padStart(10, '0');
                
                const authMessage = JSON.stringify({
                    key: {
                        service_id: parseInt(this.serviceId),
                        key: this.serviceKey,
                        event_mask: eventMaskBinary
                    }
                });
                
                logger.info('Authenticating with SparkTG', {
                    service_id: this.serviceId,
                    event_mask_binary: eventMaskBinary
                });
                
                this.ws.send(authMessage);
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data.toString());
            });

            this.ws.on('error', (error) => {
                logger.error('SparkTG WebSocket error', { error: error.message });
            });

            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                logger.warn('SparkTG WebSocket closed', { code, reason: reason.toString() });
                this.scheduleReconnect();
            });

        } catch (error) {
            logger.error('Failed to connect to SparkTG WebSocket', { error: error.message });
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached for SparkTG WebSocket');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        
        logger.info(`Scheduling SparkTG WebSocket reconnect in ${delay}ms`, {
            attempt: this.reconnectAttempts
        });

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * Handle incoming WebSocket message
     */
    async handleMessage(data) {
        try {
            const event = JSON.parse(data);
            
            // Check if this is an authentication response
            if (event.status || event.result || event.code) {
                if (event.status === 'ok' || event.result === 'success' || event.code === 200) {
                    logger.info('SparkTG WebSocket authenticated successfully');
                } else {
                    logger.error('SparkTG authentication failed', { status: event.status, message: event.message });
                }
                return;
            }
            
            logger.info('SparkTG event received', { 
                eventType: event.event,
                callId: event.xnid,
                number: event.number
            });

            // Store event in database and broadcast
            await this.storeEvent(event);
            await this.processEvent(event);

        } catch (error) {
            logger.error('Error handling SparkTG message', { 
                error: error.message,
                data: data?.substring(0, 100)
            });
        }
    }

    /**
     * Store event in call_events table
     */
    async storeEvent(event) {
        try {
            // Parse event data
            let eventData = null;
            if (event.data && event.data !== '') {
                try {
                    eventData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                } catch {
                    eventData = { raw: event.data };
                }
            }

            // Try to find related appointment from ongoing_calls
            let appointmentId = null;
            let centerId = null;
            
            if (event.xnid) {
                const ongoingCall = await query(
                    'SELECT appointment_id, center_id FROM ongoing_calls WHERE call_id = ? LIMIT 1',
                    [event.xnid]
                );
                if (ongoingCall && ongoingCall.length > 0) {
                    appointmentId = ongoingCall[0].appointment_id;
                    centerId = ongoingCall[0].center_id;
                }
            }

            // Insert event
            const insertParams = [
                event.xnid || null,
                event.event,
                event.svc || null,
                event.agent || null,
                event.agent || null,
                event.number || null,
                event.country_code || '91',
                event.type || null,
                eventData ? JSON.stringify(eventData) : null,
                event.time || Date.now(),
                appointmentId,
                centerId,
                0
            ];

            await query(
                `INSERT INTO call_events (
                    call_id, event_type, service_id, agent_id, agent_number, 
                    customer_number, country_code, call_type, event_data, 
                    event_time, appointment_id, center_id, processed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                insertParams
            );

        } catch (error) {
            logger.error('Failed to store call event', { 
                error: error.message,
                eventType: event.event,
                callId: event.xnid
            });
        }
    }

    /**
     * Process and broadcast event to CRM clients
     */
    async processEvent(event) {
        if (!this.io) return;

        const eventType = event.event;
        const callId = event.xnid;
        const customerNumber = event.number;

        // Create standardized event payload
        const payload = {
            callId,
            eventType,
            customerNumber,
            agentId: event.agent,
            callType: event.type,
            timestamp: event.time,
            serviceId: event.svc
        };

        // Handle specific events
        switch (eventType) {
            case 'CustomerRing':
                payload.status = 'ringing';
                payload.message = 'Calling customer...';
                break;

            case 'CustomerUp':
                payload.status = 'customer_answered';
                payload.message = 'Customer answered';
                break;

            case 'AgentRing':
                payload.status = 'agent_ringing';
                payload.message = 'Agent phone ringing...';
                break;

            case 'AgentUp':
                payload.status = 'connected';
                payload.message = 'Call connected';
                // Update ongoing_calls status
                await this.updateOngoingCallStatus(callId, 'connected');
                break;

            case 'CustomerHangup':
                payload.status = 'ended';
                payload.message = 'Customer disconnected';
                payload.hangupBy = 'customer';
                // Trigger webhook BEFORE removing from ongoing_calls
                await this.triggerTPAWebhook(eventType, callId, payload);
                await this.removeOngoingCall(callId);
                return; // Skip webhook trigger at the end since we already triggered it

            case 'AgentHangup':
                payload.status = 'ended';
                payload.message = 'Agent disconnected';
                payload.hangupBy = 'agent';
                // Trigger webhook BEFORE removing from ongoing_calls
                await this.triggerTPAWebhook(eventType, callId, payload);
                await this.removeOngoingCall(callId);
                return; // Skip webhook trigger at the end since we already triggered it

            case 'HoldUnhold':
                const holdData = event.data;
                payload.status = holdData === 'Hold' ? 'on_hold' : 'connected';
                payload.message = holdData === 'Hold' ? 'Call on hold' : 'Call resumed';
                break;

            case 'CallDetails':
                // Parse CDR data
                try {
                    const cdrData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                    payload.cdr = cdrData.cdr;
                    payload.status = 'completed';
                    payload.message = 'Call completed';
                } catch (e) {
                    payload.cdr = event.data;
                }
                break;

            case 'QueueEvent':
                payload.status = 'in_queue';
                payload.queue = event.data;
                payload.message = `Call in queue: ${event.data}`;
                break;

            case 'AgentStatus':
                // Agent logged in/out
                try {
                    const statusData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                    payload.agentStatus = statusData;
                } catch (e) {
                    payload.agentStatus = event.data;
                }
                break;
        }

        // Broadcast to all connected CRM clients
        const connectedClients = this.io.sockets.sockets.size;
        logger.info('Broadcasting to Socket.IO clients', {
            connectedClients,
            eventType,
            callId,
            status: payload.status
        });
        
        this.io.emit('call_event', payload);
        logger.info('Broadcasted call_event to all clients');

        // Also emit to specific call room if exists
        if (callId) {
            this.io.to(`call_${callId}`).emit('call_update', payload);
            logger.info(`Emitted to call room: call_${callId}`);
        }

        // Emit to customer number room for incoming call alerts
        if (customerNumber) {
            this.io.to(`customer_${customerNumber}`).emit('call_update', payload);
            logger.info(`Emitted to customer room: customer_${customerNumber}`);
        }

        logger.info('Call event broadcasted successfully', { eventType, callId, status: payload.status });

        // Trigger TPA webhook for key call events
        await this.triggerTPAWebhook(eventType, callId, payload);
    }

    /**
     * Update ongoing call status
     */
    async updateOngoingCallStatus(callId, status) {
        try {
            await query(
                'UPDATE ongoing_calls SET call_type = ?, updated_at = NOW() WHERE call_id = ?',
                [status, callId]
            );
        } catch (error) {
            logger.error('Failed to update ongoing call status', { error: error.message, callId });
        }
    }

    /**
     * Remove from ongoing calls when call ends
     */
    async removeOngoingCall(callId) {
        try {
            await query('DELETE FROM ongoing_calls WHERE call_id = ?', [callId]);
        } catch (error) {
            logger.error('Failed to remove ongoing call', { error: error.message, callId });
        }
    }

    /**
     * Trigger TPA webhook for call events
     */
    async triggerTPAWebhook(eventType, callId, payload) {
        try {
            // Only trigger webhooks for key events
            const webhookEvents = ['CustomerUp', 'AgentUp', 'CustomerHangup', 'AgentHangup', 'CallDetails'];
            if (!webhookEvents.includes(eventType)) {
                return;
            }

            // Get appointment details from ongoing_calls
            const ongoingCall = await query(
                'SELECT appointment_id, center_id FROM ongoing_calls WHERE call_id = ? LIMIT 1',
                [callId]
            );

            if (!ongoingCall || ongoingCall.length === 0) {
                logger.info('No ongoing call found for webhook', { callId, eventType });
                return;
            }

            const appointmentId = ongoingCall[0].appointment_id;
            
            // Get full appointment details
            const appointment = await query(
                `SELECT a.*, c.client_name 
                 FROM appointments a 
                 LEFT JOIN clients c ON a.client_id = c.id 
                 WHERE a.id = ?`,
                [appointmentId]
            );

            if (!appointment || appointment.length === 0) {
                logger.warn('Appointment not found for webhook', { appointmentId, callId });
                return;
            }

            const apt = appointment[0];

            // Only trigger webhooks for CD TPA appointments
            if (apt.client_id !== 24) {
                logger.info('Skipping webhook - not CD TPA appointment', { 
                    appointmentId, 
                    clientId: apt.client_id, 
                    clientName: apt.client_name 
                });
                return;
            }

            // Map call events to webhook event types
            const eventMap = {
                'CustomerUp': 'call_started',
                'AgentUp': 'call_connected',
                'CustomerHangup': 'call_ended',
                'AgentHangup': 'call_ended',
                'CallDetails': 'call_completed'
            };

            const webhookEventType = eventMap[eventType];
            if (!webhookEventType) {
                return;
            }

            // Build webhook payload
            const webhookPayload = {
                case_number: apt.case_number,
                application_number: apt.application_number || '',
                data: {
                    patient_name: `${apt.customer_first_name} ${apt.customer_last_name || ''}`.trim(),
                    patient_phone: apt.customer_mobile,
                    patient_email: apt.customer_email,
                    appointment_date: apt.appointment_date,
                    appointment_time: apt.appointment_time,
                    call_id: callId,
                    call_event: eventType,
                    call_status: payload.status,
                    call_type: payload.callType,
                    agent_id: payload.agentId,
                    customer_number: payload.customerNumber,
                    timestamp: new Date().toISOString(),
                    hangup_by: payload.hangupBy || null
                }
            };

            // Trigger webhook
            await TPAWebhookService.sendWebhook(apt.client_id, webhookEventType, webhookPayload);
            
            logger.info('TPA webhook triggered for call event', {
                appointmentId,
                callId,
                eventType,
                webhookEventType,
                case_number: apt.case_number
            });

        } catch (error) {
            logger.error('Failed to trigger TPA webhook for call event', {
                callId,
                eventType,
                error: error.message
            });
        }
    }

    /**
     * Get current connection status
     */
    getStatus() {
        return {
            connected: this.isConnected,
            serviceId: this.serviceId,
            reconnectAttempts: this.reconnectAttempts
        };
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            logger.info('SparkTG WebSocket disconnected');
        }
    }
}

// Export singleton instance
module.exports = new SparkTGSocketService();
