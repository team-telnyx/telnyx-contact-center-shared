/**
 * Polycom REST API Library
 * 
 * Handles communication with Polycom VVX phones via HTTP REST API.
 */

import http from 'http';
import https from 'https';

const DEFAULT_USER = 'Polycom';

/**
 * Send request to Polycom Phone REST API
 */
async function sendRequest(config, method, endpoint, body = null) {
  const { ip, port = 80, password } = config;
  const username = DEFAULT_USER;

  const isHttps = port === 443 || port === '443';
  const lib = isHttps ? https : http;

  const payload = body ? JSON.stringify(body) : null;

  const options = {
    hostname: ip,
    port: port,
    path: endpoint,
    method: method,
    rejectUnauthorized: false,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    timeout: 5000
  };

  if (payload) {
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let jsonResponse;
        try {
          if (data) jsonResponse = JSON.parse(data);
        } catch (e) {
          // ignore json error
        }

        const result = {
          success: res.statusCode === 200 && jsonResponse?.Status === '2000',
          statusCode: res.statusCode,
          data: jsonResponse || data,
          polycomStatus: jsonResponse?.Status
        };

        if (res.statusCode === 200 && jsonResponse?.Status !== '2000') {
          result.error = `Polycom Error ${jsonResponse?.Status}: ${getPolycomErrorMessage(jsonResponse?.Status)}`;
          result.success = false;
        } else if (res.statusCode !== 200) {
          result.error = `HTTP Error ${res.statusCode}`;
          result.success = false;
        }

        resolve(result);
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: `Network error: ${e.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function getPolycomErrorMessage(code) {
  const codes = {
    '2000': 'Success',
    '4000': 'Action failed (Invalid state or busy)',
    '4001': 'Invalid parameter',
    '4003': 'Invalid line index',
    '4004': 'Internal error'
  };
  return codes[code] || 'Unknown error';
}

/**
 * Get Active Call Reference (Handle)
 * Helper to fetch the first active call handle
 */
async function getActiveCallHandle(config) {
  // Try newer v2 API first, fallback to v1 if needed (v1 usually doesn't return list easily)
  // Assuming v1 callStatus works
  const result = await sendRequest(config, 'GET', '/api/v1/callctrl/callStatus');
  
  if (result.success && result.data?.data?.CallHandle) {
      // Single call handle in some firmware versions?
      // Or it might be a list. Let's inspect logs if this fails.
      // Usually it returns: { data: { CallHandle: "..." } } or list
      return result.data.data.CallHandle; 
  }
  
  // If v1 fails or empty, we might need v2 webCallControl/callStatus mentioned in docs
  // but let's stick to v1 base URL structure first as user mentioned /api/v1/callctrl/...
  
  return null;
}

/**
 * CTI Actions
 */
export const PolycomAPI = {
  // Call Control
  dial: (config, number) => sendRequest(config, 'POST', '/api/v1/callctrl/dial', { data: { Dest: number, Line: "1", Type: "TEL" } }),
  
  answer: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/answer', { data: { Line: "1" } }),
  
  // For Hangup/Hold we need a Call Handle (Ref).
  // We'll wrap these to fetch the handle first.
  hangup: async (config) => {
      // Try to end specific call if we can find handle, otherwise try without Ref (might fail)
      // Some docs say Ref is mandatory.
      const handle = await getActiveCallHandle(config);
      if (!handle) return { success: false, error: "No active call found to hangup" };
      
      return sendRequest(config, 'POST', '/api/v1/callctrl/endCall', { data: { Ref: handle } });
  },
  
  hold: async (config) => {
      const handle = await getActiveCallHandle(config);
      if (!handle) return { success: false, error: "No active call found to hold" };
      
      return sendRequest(config, 'POST', '/api/v1/callctrl/hold', { data: { Ref: handle } });
  },
  
  // Mute is usually global for the active call/line
  mute: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/mute', { data: { Mute: "1", Line: "1" } }),
  unmute: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/mute', { data: { Mute: "0", Line: "1" } }),

  // Management
  checkStatus: (config) => sendRequest(config, 'GET', '/api/v2/mgmt/device/info'),
  getLogs: (config) => sendRequest(config, 'GET', '/api/v1/mgmt/log'),
  
  // Helper to debug call status
  getCallStatus: (config) => sendRequest(config, 'GET', '/api/v1/callctrl/callStatus'),
  
  testConnection: (config) => sendRequest(config, 'GET', '/api/v2/mgmt/device/info')
};
