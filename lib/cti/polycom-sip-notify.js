/**
 * Polycom SIP NOTIFY CTI Library
 * 
 * This library handles SIP NOTIFY messages for Polycom VVX series phones
 * to enable Computer Telephony Integration (CTI) functionality.
 */

import dgram from 'dgram';
import os from 'os';

// Polycom VVX specific SIP NOTIFY templates
const POLYCOM_NOTIFY_TEMPLATES = {
  dial: (number) => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Number>${number}</Number>
    <Action>dial</Action>
  </Call>
</PolycomIPPhone>`,

  answer: () => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>answer</Action>
  </Call>
</PolycomIPPhone>`,

  hangup: () => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>hangup</Action>
  </Call>
</PolycomIPPhone>`,

  hold: () => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>hold</Action>
  </Call>
</PolycomIPPhone>`,

  unhold: () => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>unhold</Action>
  </Call>
</PolycomIPPhone>`,

  mute: () => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>mute</Action>
  </Call>
</PolycomIPPhone>`,

  transfer: (number) => `NOTIFY sip:{username}@{host}:{port} SIP/2.0
Via: SIP/2.0/UDP {local_ip}:{local_port};branch={branch}
To: <sip:{username}@{host}:{port}>
From: <sip:cti@{local_ip}:{local_port}>;tag={tag}
Call-ID: {call_id}
CSeq: 1 NOTIFY
Event: polycom-call
Content-Type: application/polycom-call+xml
Content-Length: {content_length}

<PolycomIPPhone>
  <Call>
    <Action>transfer</Action>
    <Number>${number}</Number>
  </Call>
</PolycomIPPhone>`
};

/**
 * Generate unique identifiers for SIP messages
 */
function generateSipId() {
  return Math.random().toString(36).substr(2, 9);
}

function generateBranch() {
  return 'z9hG4bK' + generateSipId();
}

/**
 * Get local IP address suitable for SIP traffic
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Helper to create and bind socket
 */
function createBoundSocket() {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    
    // Try to bind to 5080 first
    client.on('error', (err) => {
        // If bind fails, just ignore and let OS pick port
        // We'll update header with actual port later if needed, 
        // but for now we rely on OS ephemeral port
        client.close();
        resolve(dgram.createSocket('udp4')); // fallback to random port
    });

    try {
        client.bind(5080, () => {
             resolve(client);
        });
    } catch(e) {
        resolve(dgram.createSocket('udp4'));
    }
  });
}

/**
 * Send SIP message (generic)
 */
async function sendSipMessage(ip, port, messageBuilder) {
    const client = await createBoundSocket();
    const localIP = getLocalIP();
    const localPort = client.address().port; // Get actual bound port

    // Build message with correct local IP and Port
    const message = messageBuilder(localIP, localPort);
    const buffer = Buffer.from(message, 'utf8');

    return new Promise((resolve, reject) => {
      // Listen for response
      client.on('message', (msg) => {
        const response = msg.toString();
        client.close();
        
        const firstLine = response.split('\r\n')[0];
        const success = firstLine.includes('200 OK');
        
        resolve({
          success,
          response: firstLine,
          fullResponse: response,
          timestamp: new Date().toISOString(),
          error: success ? undefined : `Phone rejected command: ${firstLine}`
        });
      });

      client.send(buffer, 0, buffer.length, port, ip, (err) => {
        if (err) {
          client.close();
          reject(new Error(`Failed to send SIP message: ${err.message}`));
        }
      });

      // Set timeout
      setTimeout(() => {
        client.close();
        resolve({
          success: false,
          error: 'Timeout - no response received from phone',
          timestamp: new Date().toISOString()
        });
      }, 5000);
    });
}


/**
 * Send SIP NOTIFY message to Polycom phone
 */
export async function sendPolycomNotify(phoneConfig, action, params = {}) {
  const { ip, port = 5060, username = '' } = phoneConfig;
    
  if (!ip || !POLYCOM_NOTIFY_TEMPLATES[action]) {
    throw new Error(`Invalid phone IP or unsupported action: ${action}`);
  }

  const template = POLYCOM_NOTIFY_TEMPLATES[action];
  
  return sendSipMessage(ip, port, (localIP, localPort) => {
      const xmlContent = action === 'dial' || action === 'transfer' 
      ? template(params.number) 
      : template();

      // Extract XML content for length calculation
      const xmlMatch = xmlContent.match(/<PolycomIPPhone>.*<\/PolycomIPPhone>/s);
      const xmlBody = xmlMatch ? xmlMatch[0] : '';

      return xmlContent
        .replace(/{username}/g, username)
        .replace(/{host}/g, ip)
        .replace(/{port}/g, port)
        .replace(/{local_ip}/g, localIP)
        .replace(/{local_port}/g, localPort) 
        .replace(/{branch}/g, generateBranch())
        .replace(/{tag}/g, generateSipId())
        .replace(/{call_id}/g, `cti-${Date.now()}-${generateSipId()}`)
        .replace(/{content_length}/g, Buffer.byteLength(xmlBody, 'utf8'));
  }).then(result => ({ ...result, action, target: `${ip}:${port}` }));
}

/**
 * Test connection to Polycom phone (SIP OPTIONS)
 */
export async function testPolycomConnection(phoneConfig) {
  const { ip, port = 5060, username = '' } = phoneConfig;

  return sendSipMessage(ip, port, (localIP, localPort) => {
      return `OPTIONS sip:${username}@${ip}:${port} SIP/2.0
Via: SIP/2.0/UDP ${localIP}:${localPort};branch=${generateBranch()}
To: <sip:${username}@${ip}:${port}>
From: <sip:cti@${localIP}:${localPort}>;tag=${generateSipId()}
Call-ID: test-${Date.now()}-${generateSipId()}
CSeq: 1 OPTIONS
Content-Length: 0

`;
  });
}

/**
 * Supported CTI actions for Polycom phones
 */
export const SUPPORTED_ACTIONS = [
  'dial',
  'answer', 
  'hangup',
  'hold',
  'unhold',
  'mute',
  'transfer'
];

/**
 * Validate phone configuration
 */
export function validatePolycomConfig(phoneConfig) {
  const { ip, port, username } = phoneConfig;
  
  if (!ip) {
    throw new Error('Phone IP address is required');
  }
  
  if (port && isNaN(parseInt(port))) {
    throw new Error('Invalid port number');
  }
  
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (!ipRegex.test(ip)) {
    throw new Error('Invalid IP address format');
  }
  
  return true;
}
