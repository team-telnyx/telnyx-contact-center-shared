import dgram from 'dgram';

const POLYCOM_NOTIFY_TEMPLATES = {
  // ... (templates omitted for brevity in test script, not needed for OPTIONS) ...
};

function generateSipId() {
  return Math.random().toString(36).substr(2, 9);
}

function generateBranch() {
  return 'z9hG4bK' + generateSipId();
}

function getLocalIP() {
  return '10.10.10.172'; // Hardcoded local IP of Mac Mini
}

async function testPolycomConnection(phoneConfig) {
  const { ip, port = 5060, username = '' } = phoneConfig;

  console.log(`Sending SIP OPTIONS to ${ip}:${port}...`);

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
    
    // Bind to port 5080 explicitly so it matches our Via header
    try {
        client.bind(5080);
    } catch (e) {
        console.log('Port 5080 busy, letting OS pick random port');
    }

    const buffer = Buffer.from(optionsMessage, 'utf8'); 

    client.on('message', (msg, rinfo) => {
      console.log(`Received message from ${rinfo.address}:${rinfo.port}`);
      const response = msg.toString();
      client.close();
      
      resolve({
        success: true,
        response: response,
        timestamp: new Date().toISOString()
      });
    });

    client.send(buffer, 0, buffer.length, port, ip, (err) => {
      if (err) {
        client.close();
        reject(new Error(`Failed to send SIP OPTIONS: ${err.message}`));
      } else {
        console.log('Packet sent successfully.');
      }
    });

    setTimeout(() => {
      client.close();
      resolve({
        success: false,
        error: 'Timeout - no response received',
        timestamp: new Date().toISOString()
      });
    }, 5000);
  });
}

const config = {
  ip: '10.10.10.121',
  port: 5060,
  username: 'polyuser'
};

testPolycomConnection(config)
  .then(result => console.log('Final Result:', result))
  .catch(err => console.error('Fatal Error:', err));
