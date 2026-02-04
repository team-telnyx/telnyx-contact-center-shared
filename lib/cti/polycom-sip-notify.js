/**
 * Polycom SIP NOTIFY CTI Library
 * 
 * This library handles SIP NOTIFY messages for Polycom VVX series phones
 * to enable Computer Telephony Integration (CTI) functionality.
 * 
 * Supported commands:
 * - dial: Initiate outbound call
 * - answer: Answer incoming call
 * - hangup: End current call
 * - hold/unhold: Hold/resume call
 * - mute: Toggle mute
 * - transfer: Transfer call to another number
 */

import dgram from 'dgram';

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
 * Get local IP address (simplified - in production you'd want more robust detection)
 */
function getLocalIP() {
  // For demo purposes, return localhost
  // In production, you'd detect the actual interface IP
  return '127.0.0.1';
}

/**
 * Send SIP NOTIFY message to Polycom phone
 */
export async function sendPolycomNotify(phoneConfig, action, params = {}) {
  try {
    const { ip, port = 5060, username = '' } = phoneConfig;
    
    if (!ip || !POLYCOM_NOTIFY_TEMPLATES[action]) {
      throw new Error(`Invalid phone IP or unsupported action: ${action}`);
    }

    // Generate message from template
    const template = POLYCOM_NOTIFY_TEMPLATES[action];
    const xmlContent = action === 'dial' || action === 'transfer' 
      ? template(params.number) 
      : template();

    // Extract XML content for length calculation
    const xmlMatch = xmlContent.match(/<PolycomIPPhone>.*<\/PolycomIPPhone>/s);
    const xmlBody = xmlMatch ? xmlMatch[0] : '';
    
    // Replace placeholders
    const message = xmlContent
      .replace(/{username}/g, username)
      .replace(/{host}/g, ip)
      .replace(/{port}/g, port)
      .replace(/{local_ip}/g, getLocalIP())
      .replace(/{local_port}/g, '5080') // Use different port for CTI
      .replace(/{branch}/g, generateBranch())
      .replace(/{tag}/g, generateSipId())
      .replace(/{call_id}/g, `cti-${Date.now()}-${generateSipId()}`)
      .replace(/{content_length}/g, Buffer.byteLength(xmlBody, 'utf8'));

    // Send UDP packet
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const buffer = Buffer.from(message, 'utf8');

      client.send(buffer, 0, buffer.length, port, ip, (err) => {
        client.close();
        
        if (err) {
          reject(new Error(`Failed to send SIP NOTIFY: ${err.message}`));
        } else {
          resolve({
            success: true,
            action,
            target: `${ip}:${port}`,
            messageLength: buffer.length,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Set timeout
      setTimeout(() => {
        client.close();
        reject(new Error('SIP NOTIFY timeout'));
      }, 5000);
    });

  } catch (error) {
    throw new Error(`Polycom SIP NOTIFY error: ${error.message}`);
  }
}

/**
 * Test connection to Polycom phone (SIP OPTIONS)
 */
export async function testPolycomConnection(phoneConfig) {
  const { ip, port = 5060, username = '' } = phoneConfig;

  const optionsMessage = `OPTIONS sip:${username}@${ip}:${port} SIP/2.0
Via: SIP/2.0/UDP ${getLocalIP()}:5080;branch=${generateBranch()}
To: <sip:${username}@${ip}:${port}>
From: <sip:cti@${getLocalIP()}:5080>;tag=${generateSipId()}
Call-ID: test-${Date.now()}-${generateSipId()}
CSeq: 1 OPTIONS
Content-Length: 0

`;

  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const buffer = Buffer.from(optionsMessage, 'utf8');

    // Set up response listener
    client.on('message', (msg) => {
      const response = msg.toString();
      client.close();
      
      if (response.includes('200 OK')) {
        resolve({
          success: true,
          response: response,
          timestamp: new Date().toISOString()
        });
      } else {
        resolve({
          success: false,
          response: response,
          timestamp: new Date().toISOString()
        });
      }
    });

    client.send(buffer, 0, buffer.length, port, ip, (err) => {
      if (err) {
        client.close();
        reject(new Error(`Failed to send SIP OPTIONS: ${err.message}`));
      }
    });

    // Set timeout
    setTimeout(() => {
      client.close();
      reject(new Error('SIP OPTIONS timeout - phone may be offline'));
    }, 3000);
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
  
  // Validate IP format
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (!ipRegex.test(ip)) {
    throw new Error('Invalid IP address format');
  }
  
  return true;
}