import { sendPolycomNotify } from './lib/cti/polycom-sip-notify.js';

const config = {
  ip: '10.10.10.121',
  port: 5060,
  username: 'polyuser'
};

const number = '+48602410402';

console.log(`Dialing ${number} on Polycom...`, config);

sendPolycomNotify(config, 'dial', { number })
  .then(result => {
    console.log('Dial Result:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Dial Error:', err);
  });
