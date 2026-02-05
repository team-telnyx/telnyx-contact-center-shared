/**
 * Polycom REST API Library
 * 
 * Handles communication with Polycom VVX phones via HTTP REST API.
 * Default credentials: Polycom / 456 (or custom password)
 */

import http from 'http';
import https from 'https';

const DEFAULT_USER = 'Polycom';

/**
 * Send request to Polycom Phone REST API
 */
async function sendRequest(config, method, endpoint, body = null) {
  const { ip, port = 80, password } = config;
  const username = DEFAULT_USER; // Always use Polycom as requested

  const isHttps = port === 443 || port === '443';
  const lib = isHttps ? https : http;

  // Prepare payload
  const payload = body ? JSON.stringify(body) : null;

  const options = {
    hostname: ip,
    port: port,
    path: endpoint,
    method: method,
    rejectUnauthorized: false, // Allow self-signed certs
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    timeout: 5000 // 5s timeout
  };

  if (payload) {
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Try to parse JSON response
        let jsonResponse;
        try {
          if (data) jsonResponse = JSON.parse(data);
        } catch (e) {
          // If not JSON (e.g. HTML error), keep as string or ignore
        }

        const result = {
          success: res.statusCode === 200 && jsonResponse?.Status === '2000',
          statusCode: res.statusCode,
          data: jsonResponse || data,
          polycomStatus: jsonResponse?.Status
        };

        // Polycom specific status codes
        // 2000: Success
        // 4000: Invalid State / Busy / Blocked
        // 4001: Invalid Parameter
        // 4003: Invalid Line
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
    '4002': 'Credentials invalid', // Unlikely if HTTP 200
    '4003': 'Invalid line index',
    '4004': 'Internal error'
  };
  return codes[code] || 'Unknown error';
}

/**
 * CTI Actions
 */
export const PolycomAPI = {
  // Call Control
  dial: (config, number) => sendRequest(config, 'POST', '/api/v1/callctrl/dial', { dest: number, line: 1 }),
  answer: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/answer', { line: 1 }), // Usually needs handle/ref, but try general answer
  hangup: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/endCall'), // Ends active call
  hold: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/hold'), // Toggles hold? Or needs explicit ref
  mute: (config) => sendRequest(config, 'POST', '/api/v1/callctrl/mute', { mute: true }), // Needs testing if toggle or set
  
  // Management
  checkStatus: (config) => sendRequest(config, 'GET', '/api/v2/mgmt/device/info'),
  getLogs: (config) => sendRequest(config, 'GET', '/api/v1/mgmt/log'),
  reboot: (config) => sendRequest(config, 'POST', '/api/v1/mgmt/safeReboot'),
  
  // Test connection (alias for checkStatus)
  testConnection: (config) => sendRequest(config, 'GET', '/api/v2/mgmt/device/info')
};
