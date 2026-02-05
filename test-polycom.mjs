import { testPolycomConnection } from './lib/cti/polycom-sip-notify.js';

const config = {
  ip: '10.10.10.121',
  port: 5060,
  username: 'polyuser'
};

console.log('Testing connection to Polycom...', config);

testPolycomConnection(config)
  .then(result => {
    console.log('Result:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Error:', err);
  });
